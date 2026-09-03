/**
 * World Model Builder
 *
 * Aggregates persisted, field-scoped evidence into one coherent World Model:
 * evidence → domain states (weather, satellite, sensors, soil, water, terrain,
 * crop) → anomalies/risks/contradictions → coverage descriptor → snapshot.
 *
 * Truth rules:
 *  - Evidence Coverage is a labelled descriptor (counts + per-domain states),
 *    never called "confidence".
 *  - Each domain carries its evidence state (OBSERVED/DERIVED/ESTIMATED/
 *    MODEL_DERIVED/... or UNKNOWN/NO_DATA) and its provenance.
 *  - A domain with no evidence is UNKNOWN — never filled with fabricated data.
 */
import { listEvidence, evidenceSummary, listSoilObservations, listWaterObservations, listTerrainProducts } from '../../data/evidence';
import { listAnomalies, listRisks, listContradictions, listInvestigations, listFarmMemory } from '../../data/intel';
import { latestObservationsByType, listObservations } from '../../data/sensors';
import { latestCropCycle } from '../../data/crops';
import { latestWorldModelSnapshot, saveWorldModelSnapshot } from '../../data/system';
import { getField, type FieldRow } from '../../data/fields';

export interface WorldModelState {
  field_id: string;
  state: Record<string, any>;
  coverage: Record<string, any>;
  anomalies: any[];
  risks: any[];
  contradictions: any[];
  investigations: any[];
  farm_memory: any[];
  evidence_gaps: string[];
  version: number;
  last_updated: string;
  metrics_computed_by?: string;
}

export async function buildWorldModel(field: FieldRow, userId: string): Promise<WorldModelState> {
  const fieldId = field.id;
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  const bySource: Record<string, any[]> = {};
  for (const e of evidence) {
    if (!bySource[e.source]) bySource[e.source] = [];
    bySource[e.source].push(e);
  }

  const latestOf = (source: string) => bySource[source]?.[0] || null;

  // ── Domains ──────────────────────────────────────────────────────
  const weatherEv = latestOf('ENVIRONMENT');
  const weather = weatherEv
    ? {
        state: weatherEv.state,
        data: weatherEv.measurement,
        provider: weatherEv.provider || null,
        observation_time: weatherEv.observation_time,
        uncertainty: weatherEv.uncertainty || null,
      }
    : { state: 'UNKNOWN', data: null, provider: null, observation_time: null, uncertainty: null };

  const satEv = latestOf('EARTH_OBSERVATION');
  const satellite = satEv
    ? {
        state: satEv.state,
        data: {
          product_id: (satEv.measurement as any)?.product_id,
          collection: (satEv.measurement as any)?.collection,
          cloud_cover: (satEv.measurement as any)?.properties?.['eo:cloud_cover'] ?? null,
          datetime: satEv.observation_time,
        },
        provider: satEv.provider || null,
        observation_time: satEv.observation_time,
        provenance: satEv.provenance,
      }
    : { state: 'UNKNOWN', data: null, provider: null, observation_time: null };

  // Sensors: real persisted observations only
  const obs = await listObservations({ fieldId, userId, limit: 500 });
  const byTypeRows = await latestObservationsByType(fieldId, 20);
  const activeDevices = new Set(obs.map((o) => o.device_id).filter(Boolean));
  const latestObs = await (async () => {
    const rows = byTypeRows || [];
    return rows.map((r) => ({
      id: r.id, device_id: r.device_id, sensor_type: r.sensor_type, value: r.value,
      unit: r.unit, quality: r.quality, timestamp: r.timestamp,
    }));
  })();
  const sensors = obs.length > 0 || activeDevices.size > 0
    ? {
        state: 'OBSERVED',
        active_count: activeDevices.size,
        device_count: activeDevices.size,
        latest_readings: latestObs,
        latest_observation_time: latestObs[0]?.timestamp || null,
      }
    : { state: 'NO_DATA', active_count: 0, device_count: 0, latest_readings: [], latest_observation_time: null };

  // Soil: persisted per-property rows (with state per property)
  const soilRows = await listSoilObservations(fieldId);
  const soil = soilRows.length > 0
    ? {
        state: 'AVAILABLE',
        properties: soilRows.map((r) => ({
          property: r.property, value: r.value, unit: r.unit, state: r.state,
          source: r.source, timestamp: r.timestamp, uncertainty: r.uncertainty,
        })),
      }
    : { state: 'UNKNOWN', properties: [] };

  // Water
  const waterRows = await listWaterObservations(fieldId);
  const waterDomains: Record<string, any> = {};
  for (const w of waterRows) waterDomains[w.domain] = { state: w.state, data: w.data, provider: w.provider, observed_at: w.observed_at };
  const water = { state: Object.keys(waterDomains).length > 0 ? 'AVAILABLE' : 'UNKNOWN', domains: waterDomains };

  // Terrain
  const terrainRows = await listTerrainProducts(fieldId);
  const terrainData: Record<string, any> = {};
  for (const t of terrainRows) terrainData[t.kind] = { state: t.state, data: t.data, provider: t.provider };
  const terrain = { state: Object.keys(terrainData).length > 0 ? 'AVAILABLE' : 'UNKNOWN', products: terrainData };

  // Crop
  const cropEv = latestOf('AGRICULTURE');
  const cycle = await latestCropCycle(fieldId);
  const crop = cycle || cropEv
    ? {
        state: cycle ? 'OBSERVED' : cropEv.state,
        data: {
          crop_type: cycle?.crop_type || (cropEv?.measurement as any)?.crop_type || null,
          variety: cycle?.variety || null,
          season: cycle?.season || null,
          sowing_date: cycle?.sowing_date || null,
          expected_harvest_date: cycle?.expected_harvest_date || null,
          status: cycle?.status || null,
          source_evidence: cropEv ? cropEv.id : null,
        },
      }
    : { state: 'UNKNOWN', data: null };

  // ── Intelligence layers ──────────────────────────────────────────
  const anomalies = await listAnomalies(fieldId, 100);
  const risks = await listRisks(fieldId, true, 100);
  const contradictions = await listContradictions(fieldId, true, 100);
  const investigations = await listInvestigations(fieldId, userId);
  const farmMemory = await listFarmMemory(fieldId);

  // ── Coverage descriptor (labelled EVIDENCE_COVERAGE, never confidence) ─
  // Each domain is derived from the same underlying store the State panel
  // reads, so coverage and state can never disagree.
  const summary = await evidenceSummary(fieldId);
  const domains: Record<string, string> = {
    weather: summary.by_source['ENVIRONMENT'] ? 'AVAILABLE' : 'MISSING',
    satellite: summary.by_source['EARTH_OBSERVATION'] ? 'AVAILABLE' : 'MISSING',
    sensors: obs.length > 0 ? 'AVAILABLE' : 'MISSING',
    soil: soilRows.length > 0 ? 'AVAILABLE' : 'MISSING',
    water: Object.keys(waterDomains).length > 0 ? 'AVAILABLE' : 'MISSING',
    terrain: terrainRows.length > 0 ? 'AVAILABLE' : 'MISSING',
    crop: cycle || (cropEv?.measurement as any)?.crop_type ? 'AVAILABLE' : 'MISSING',
  };

  const gaps: string[] = [];
  if (!summary.by_source['EARTH_OBSERVATION']) gaps.push('SATELLITE: no earth-observation evidence — vegetation state unknown');
  if (!summary.by_source['PHYSICAL_HARDWARE']) gaps.push('SENSORS: no physical sensor evidence — root-zone conditions unknown');
  if (!summary.by_source['ENVIRONMENT']) gaps.push('WEATHER: no weather evidence');
  if (!summary.by_source['WATER']) gaps.push('WATER: no water evidence');
  if (!summary.by_source['AGRICULTURE']) gaps.push('SOIL/CROP: no soil or crop evidence');
  if (!summary.by_source['TERRAIN'] && terrainRows.length === 0) gaps.push('TERRAIN: no DEM elevation sample — relief context unknown');
  if (!summary.by_source['FARMER_INPUT']) gaps.push('FARMER: no farmer observations recorded');
  for (const c of contradictions) gaps.push(`CONTRADICTION: ${c.type} unresolved — requires investigation`);

  const prev = await latestWorldModelSnapshot(fieldId);
  const version = (prev?.version || 0) + 1;

  const worldModel = {
    field_id: fieldId,
    field: { name: field.name, area_hectares: field.area_hectares, centroid: field.centroid },
    state: { terrain, crop, soil, water, sensors, weather, satellite },
    coverage: {
      domains,
      total_evidence: summary.total,
      by_source: summary.by_source,
      by_state: summary.by_state,
      freshest: summary.freshest,
      stalest: summary.stalest,
      label: 'EVIDENCE_COVERAGE',
    },
    anomalies,
    risks,
    contradictions,
    investigations: investigations.map((i) => ({
      id: i.id, title: i.title, question: i.question, status: i.status,
      trigger_type: i.trigger_type, hypothesis_count: (i.hypotheses || []).length,
      created_at: i.created_at, updated_at: i.updated_at,
    })),
    farm_memory: farmMemory,
    evidence_gaps: gaps,
    version,
    last_updated: new Date().toISOString(),
    metrics_computed_by: field.metrics_computed_by,
  };

  await saveWorldModelSnapshot(fieldId, worldModel, version);
  return worldModel;
}
