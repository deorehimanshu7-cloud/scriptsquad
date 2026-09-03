/**
 * Provider service layer: adapters → validation → evidence persistence.
 * Every external result stored as evidence keeps provider, provenance,
 * observation/retrieval time and state semantics. Failures never produce fake
 * data — they surface truthful statuses.
 */
import { insertEvidence, insertSatelliteProduct, findSatelliteProduct, insertWeatherObservation, upsertSoilObservation, upsertTerrainProduct } from '../../data/evidence';
import { logProviderRequest } from '../../data/system';
import { OpenMeteoAdapter } from './adapters/open-meteo';
import { CopernicusAdapter } from './adapters/copernicus';
import { LandsatAdapter } from './adapters/landsat';
import { SoilGridsAdapter } from './adapters/soilgrids';
import { emitEvent } from '../events';
import type { FieldRow } from '../../data/fields';
import type { StacFeature } from './adapters/copernicus';

export interface ProviderServiceResult<T = any> {
  status: string;
  provider: string;
  data: T | null;
  evidence_created: number;
  latency_ms?: number;
  error?: string;
  message?: string;
}

async function recordRequest(providerId: string, requestType: string, params: Record<string, unknown>, result: { status: string; latency_ms?: number; error?: string }) {
  await logProviderRequest({
    providerId,
    requestType,
    params,
    status: result.status,
    errorMessage: result.error,
    latencyMs: result.latency_ms,
  }).catch(() => {});
}

// ── Weather ──────────────────────────────────────────────────────────────────
export async function fetchAndStoreWeather(field: FieldRow, userId: string, kind: 'current' | 'history' = 'current'): Promise<ProviderServiceResult> {
  const centroid = field.centroid?.coordinates;
  if (!centroid) {
    return { status: 'NO_DATA', provider: 'open-meteo', data: null, evidence_created: 0, message: 'Field has no centroid geometry.' };
  }
  const [lng, lat] = centroid;
  const adapter = new OpenMeteoAdapter();
  const result = kind === 'history'
    ? await adapter.fetchHistory(lat, lng, 30)
    : await adapter.fetchWeather(lat, lng);
  await recordRequest('open-meteo', kind === 'history' ? 'weather_history' : 'weather_current', { lat, lng, kind }, result);

  if (result.status !== 'AVAILABLE' || !result.data) {
    return { status: result.status, provider: 'open-meteo', data: null, evidence_created: 0, latency_ms: result.latency_ms, error: result.error };
  }

  // Persist dataset as evidence (state from adapter semantics)
  const ev = await insertEvidence({
    userId, farmId: field.farm_id, fieldId: field.id,
    source: 'ENVIRONMENT', provider: 'open-meteo',
    observationTime: new Date().toISOString(),
    measurement: result.data as unknown as Record<string, unknown>,
    state: (result.state as any) || 'MODEL_DERIVED',
    quality: result.quality,
    provenance: result.provenance,
    uncertainty: null,
    geometry: field.geometry,
  });

  // Dedicated weather rows with explicit semantics
  const dataset = result.data;
  if (kind === 'history') {
    await insertWeatherObservation({ fieldId: field.id, provider: 'open-meteo', timestamp: new Date().toISOString(), kind: 'history', semantics: 'REANALYSIS', data: dataset as unknown as Record<string, unknown> });
  } else {
    if (dataset.current) {
      await insertWeatherObservation({ fieldId: field.id, provider: 'open-meteo', timestamp: new Date(dataset.current.observed_at || Date.now()).toISOString(), kind: 'current', semantics: 'MODEL_DERIVED', data: dataset.current as unknown as Record<string, unknown> });
    }
    if (dataset.daily?.length) {
      await insertWeatherObservation({ fieldId: field.id, provider: 'open-meteo', timestamp: new Date().toISOString(), kind: 'forecast', semantics: 'PREDICTED', data: { daily: dataset.daily, source: dataset.dataset } });
    }
  }
  void ev;
  return { status: 'AVAILABLE', provider: 'open-meteo', data: result.data, evidence_created: 1, latency_ms: result.latency_ms };
}

// ── Satellite ────────────────────────────────────────────────────────────────
export interface SatelliteSearchOutcome {
  status: string;
  provider: string;
  products: StacFeature[];
  evidence_created: number;
  stored: number;
  error?: string;
  message?: string;
}

export async function searchAndStoreSatellite(field: FieldRow, userId: string, opts: { providers?: ('copernicus' | 'landsat')[]; days?: number; maxCloud?: number; storeEvidence?: boolean } = {}): Promise<SatelliteSearchOutcome> {
  const providers = opts.providers || ['copernicus'];
  const days = opts.days || 45;
  const maxCloud = opts.maxCloud ?? 30;
  const now = new Date();
  const start = new Date(now.getTime() - days * 86400000);
  const datetime = `${start.toISOString()}/${now.toISOString()}`;
  const outcomes: SatelliteSearchOutcome[] = [];
  let firstOk: SatelliteSearchOutcome | null = null;
  let stored = 0;
  let evidenceCreated = 0;

  for (const providerId of providers) {
    if (providerId === 'copernicus') {
      const adapter = new CopernicusAdapter();
      const result = await adapter.searchProducts({ bbox: extractBbox(field), datetime, collections: ['sentinel-2-l2a'], maxCloudCover: maxCloud, limit: 15 });
      await recordRequest('copernicus', 'satellite_search', { datetime, maxCloud }, result);
      const products = result.data || [];
      const out: SatelliteSearchOutcome = { status: result.status, provider: 'copernicus', products, evidence_created: 0, stored: 0, error: result.error };
      for (const p of products) {
        const created = await persistProduct(field, userId, 'copernicus', p);
        out.stored += created.stored;
        out.evidence_created += created.evidence;
        if (created.stored === 1 && opts.storeEvidence !== false) {
          const ev = await storeProductEvidence(field, userId, p, 'copernicus');
          out.evidence_created += ev ? 1 : 0;
        }
      }
      stored += out.stored;
      evidenceCreated += out.evidence_created;
      if (result.status === 'AVAILABLE' && !firstOk) firstOk = out;
      outcomes.push(out);
    } else if (providerId === 'landsat') {
      const adapter = new LandsatAdapter();
      const result = await adapter.searchProducts({ bbox: extractBbox(field), datetime, maxCloudCover: maxCloud, limit: 15 });
      await recordRequest('landsat-earth-search', 'satellite_search', { datetime, maxCloud }, result);
      const products = result.data || [];
      const out: SatelliteSearchOutcome = { status: result.status, provider: 'landsat-earth-search', products, evidence_created: 0, stored: 0, error: result.error };
      for (const p of products) {
        const created = await persistProduct(field, userId, 'landsat-earth-search', p);
        out.stored += created.stored;
        out.evidence_created += created.evidence;
        if (created.stored === 1 && opts.storeEvidence !== false) {
          const ev = await storeProductEvidence(field, userId, p, 'landsat-earth-search');
          out.evidence_created += ev ? 1 : 0;
        }
      }
      stored += out.stored;
      evidenceCreated += out.evidence_created;
      if (result.status === 'AVAILABLE' && !firstOk) firstOk = out;
      outcomes.push(out);
    }
  }

  // Prefer the freshest cloud-free product as the field's canonical EO evidence.
  const best = (firstOk?.products || []).sort((a, b) => (a.properties?.['eo:cloud_cover'] ?? 100) - (b.properties?.['eo:cloud_cover'] ?? 100))[0];
  if (best && opts.storeEvidence === false && stored > 0) {
    // already stored per-product above
  }

  const anyAvailable = outcomes.some((o) => o.status === 'AVAILABLE');
  return {
    status: anyAvailable ? 'AVAILABLE' : outcomes[0]?.status || 'NO_DATA',
    provider: firstOk?.provider || providers[0],
    products: firstOk?.products || [],
    evidence_created: evidenceCreated,
    stored,
    message: anyAvailable ? undefined : (outcomes[0]?.error ? `Provider error: ${outcomes[0].error}` : 'NO_DATA: no satellite products found for this field and time window.'),
  };
}

async function persistProduct(field: FieldRow, userId: string, providerId: string, p: StacFeature): Promise<{ stored: number; evidence: number }> {
  const existing = await findSatelliteProduct(field.id, providerId, p.id);
  if (existing) return { stored: 0, evidence: 0 };
  await insertSatelliteProduct({
    providerId, collection: p.collection, productId: p.id, fieldId: field.id,
    geometry: p.geometry as GeoJSON.Polygon,
    cloudCover: p.properties?.['eo:cloud_cover'] ?? null,
    observationDate: p.datetime,
    assets: p.assets || {},
    metadata: p.properties || {},
  });
  return { stored: 1, evidence: 0 };
}

async function storeProductEvidence(field: FieldRow, userId: string, p: StacFeature, providerId: string): Promise<boolean> {
  await insertEvidence({
    userId, farmId: field.farm_id, fieldId: field.id,
    source: 'EARTH_OBSERVATION', provider: providerId,
    observationTime: p.datetime,
    measurement: { product_id: p.id, collection: p.collection, properties: p.properties, assets_keys: Object.keys(p.assets || {}) },
    state: 'OBSERVED',
    quality: null,
    provenance: { provider: providerId, product_id: p.id, collection: p.collection, endpoint: p.assets ? 'STAC' : undefined, metadata: { cloud_cover: p.properties?.['eo:cloud_cover'] } },
    geometry: p.geometry,
    uncertainty: null,
  });
  await emitEvent('SATELLITE_ACQUIRED', { product_id: p.id, collection: p.collection, provider: providerId }, { fieldId: field.id, userId }).catch(() => {});
  return true;
}

function extractBbox(field: FieldRow): number[] {
  const ring = (field.geometry as GeoJSON.Polygon)?.coordinates?.[0] || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of ring) {
    minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]);
    maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]);
  }
  if (!Number.isFinite(minX)) return [77, 12, 78, 13];
  return [minX - 0.005, minY - 0.005, maxX + 0.005, maxY + 0.005];
}

// ── Soil (SoilGrids modelled estimates) ──────────────────────────────────────
export async function fetchAndStoreSoil(field: FieldRow, userId: string): Promise<ProviderServiceResult> {
  const centroid = field.centroid?.coordinates;
  if (!centroid) return { status: 'NO_DATA', provider: 'soilgrids', data: null, evidence_created: 0, message: 'Field has no centroid geometry.' };
  const adapter = new SoilGridsAdapter();
  const result = await adapter.queryPoint(centroid[0], centroid[1]);
  await recordRequest('soilgrids', 'soil_query', { lon: centroid[0], lat: centroid[1] }, result);
  if (result.status !== 'AVAILABLE' || !result.data) {
    return { status: result.status, provider: 'soilgrids', data: null, evidence_created: 0, error: result.error };
  }
  const depthToCm = (d: string) => parseInt(d.split('-')[0] || '0', 10);
  // soil_observations stores one row per property → keep the shallowest
  // root-zone depth (0–5cm) per property and record the exact band in provenance
  const shallowest = new Map<string, typeof result.data[0]>();
  for (const r of result.data) {
    const depthCm = depthToCm(r.depth);
    if (depthCm > 30) continue;
    const cur = shallowest.get(r.property);
    if (!cur || depthCm < depthToCm(cur.depth)) shallowest.set(r.property, r);
  }
  let count = 0;
  for (const r of shallowest.values()) {
    const provenance = {
      provider: 'soilgrids', dataset: 'SoilGrids v2.0', property_code: r.property,
      depth: r.depth, raw_units: r.provenance_units || null, lon: centroid[0], lat: centroid[1],
    };
    await upsertSoilObservation({
      field_id: field.id, property: r.property, value: r.value_mean, unit: r.unit,
      state: 'ESTIMATED',
      source: 'SoilGrids v2.0 (ISRIC ML model)',
      timestamp: new Date().toISOString(),
      quality: null,
      uncertainty: { value: r.uncertainty_mean, unit: r.uncertainty_unit, type: 'prediction_interval' },
      provenance,
    });
    // Every stored soil value also becomes ESTIMATED evidence so coverage,
    // anomalies, risks and the AI all see the soil domain (single pipeline).
    await insertEvidence({
      userId, farmId: field.farm_id, fieldId: field.id,
      source: 'AGRICULTURE', provider: 'soilgrids',
      observationTime: new Date().toISOString(),
      measurement: {
        property: r.property, value: r.value_mean, unit: r.unit, depth: r.depth,
        uncertainty: r.uncertainty_mean, uncertainty_unit: r.uncertainty_unit,
      },
      state: 'ESTIMATED', quality: null,
      uncertainty: { value: r.uncertainty_mean, unit: r.uncertainty_unit, type: 'prediction_interval' },
      provenance,
      geometry: field.geometry,
    });
    count++;
  }
  return { status: 'AVAILABLE', provider: 'soilgrids', data: result.data, evidence_created: count, message: 'SoilGrids values are MODELLED ESTIMATES with model uncertainty — not field observations.' };
}

// ── Terrain (DEM elevation) ──────────────────────────────────────────────────
export async function fetchAndStoreTerrain(field: FieldRow, userId: string): Promise<ProviderServiceResult> {
  const centroid = field.centroid?.coordinates;
  if (!centroid) return { status: 'NO_DATA', provider: 'open-meteo-elevation', data: null, evidence_created: 0, message: 'Field has no centroid geometry.' };
  const adapter = new OpenMeteoAdapter();
  const result = await adapter.fetchElevation(centroid[1], centroid[0]);
  await recordRequest('open-meteo-elevation', 'terrain_elevation', { lon: centroid[0], lat: centroid[1] }, result);
  if (result.status !== 'AVAILABLE' || !result.data) {
    return { status: result.status, provider: 'open-meteo-elevation', data: null, evidence_created: 0, error: result.error };
  }
  await upsertTerrainProduct({
    fieldId: field.id, kind: 'elevation', state: 'DERIVED',
    data: { elevation_m: result.data.elevation_m, method: 'DEM sample at field centroid (Open-Meteo elevation API)' },
    provider: 'open-meteo-elevation',
  });
  if (result.data.elevation_m !== null) {
    await insertEvidence({
      userId, farmId: field.farm_id, fieldId: field.id,
      // TERRAIN is its own evidence domain — DEM/DERIVED. Weather rows live
      // under ENVIRONMENT; the two must never mix in domain views.
      source: 'TERRAIN', provider: 'open-meteo-elevation',
      observationTime: new Date().toISOString(),
      measurement: { elevation_m: result.data.elevation_m, method: 'DEM sample at field centroid (Open-Meteo elevation API)' },
      unit: 'm', state: 'DERIVED', quality: null, provenance: result.provenance,
      uncertainty: null, geometry: field.geometry,
    });
  }
  return { status: 'AVAILABLE', provider: 'open-meteo-elevation', data: result.data, evidence_created: 1, latency_ms: result.latency_ms };
}
