import type { AppDb } from "../db";
import { nowIso } from "../db";
import { config } from "../config";
import { recordHealth, runProvider, type ProviderCtx } from "../providers/orchestrator";
import { getWeatherBundle, getElevation, getSoilMoistureNow, getAirQualityNow } from "../providers/openmeteo";
import { getDemSamples, opentopodataProvenance } from "../providers/opentopodata";
import { DEFAULT_DISCOVERY_COLLECTIONS, searchStac } from "../providers/copernicus";
import { getSoilProperties, type SoilPropertyRow } from "../providers/soilgrids";
import { getSoilPropertiesWcs } from "../providers/soilgridsWcs";
import { getWaterFeatures, osmWaterDatasetProvenance } from "../providers/osmWater";
import { deriveTerrainStats } from "./terrain";
import { addEvidence, deleteEvidenceWhere } from "./evidence";
import { getFieldRow, composeWorldModel, saveWorldModelSnapshot, latestWorldModel } from "./worldModel";
import { runIntelligence } from "./engines";
import { addMemory } from "./memory";
import { publishEvent } from "./events";
import { createJob, markRunning, finishJob } from "./jobs";
import { aoiBbox, demGridDivisions, samplePointsInside } from "../geo";
import { round } from "../util";

export type PipelineJobFn = (ctx: ProviderCtx & { field: NonNullable<ReturnType<typeof getFieldRow>> }) => Promise<unknown>;

/** Wrap a job in DB lifecycle + event publication. Never throws. */
export async function runJobGuarded(
  db: AppDb,
  input: { type: string; fieldId?: string | null; userId?: string | null },
  fn: () => Promise<void>,
): Promise<void> {
  const job = createJob(db, {
    type: input.type as never,
    fieldId: input.fieldId ?? null,
    userId: input.userId ?? null,
  });
  markRunning(db, job.id);
  try {
    await fn();
    finishJob(db, job.id, "SUCCEEDED");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishJob(db, job.id, "FAILED", { error: message });
    console.error(`[worker] job ${job.id} (${input.type}) failed:`, message);
  }
  publishEvent(db, {
    type: "JOB_UPDATED",
    user_id: input.userId ?? null,
    field_id: input.fieldId ?? null,
    payload: { job_id: job.id, type: input.type },
  });
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------
export async function refreshWeather(db: AppDb, fieldId: string): Promise<void> {
  const field = getFieldRow(db, fieldId);
  if (!field) return;
  await runJobGuarded(db, { type: "WEATHER_REFRESH", fieldId, userId: field.user_id }, async () => {
    const res = await runProvider(
      { db },
      "openmeteo",
      () => getWeatherBundle(field.centroid_lat, field.centroid_lon, { pastDays: 30, forecastDays: 7 }).then((d) => ({ data: d })),
      { timeoutMs: 25_000, retries: 1 },
    );
    if (res.status !== "AVAILABLE" || !res.data) {
      throw new Error(`Weather provider unavailable: ${res.status} ${res.error ?? ""}`);
    }
    const b = res.data;
    const now = nowIso();
    const retrieved = now;
    // de-dupe: remove model rows we are about to replace for this window
    deleteEvidenceWhere(db, fieldId, "weather");
    // The soil and environment domains also carry rows this step owns, so they
    // are replaced by exact sub_type rather than by whole domain (a domain-wide
    // delete would wipe the SoilGrids and terrain evidence produced elsewhere).
    db.conn.query("DELETE FROM evidence WHERE field_id = ? AND sub_type LIKE 'modelled_volumetric_water_%'").run(fieldId);
    db.conn.query("DELETE FROM evidence WHERE field_id = ? AND sub_type LIKE 'air_quality_%'").run(fieldId);
    let inserted = 0;

    if (b.current) {
      const rows: { sub: string; val: number | null; unit: string; label: string }[] = [
        { sub: "temperature_2m", val: b.current.temperature_2m, unit: "°C", label: "Air temperature (2 m)" },
        { sub: "relative_humidity_2m", val: b.current.relative_humidity_2m, unit: "%", label: "Relative humidity (2 m)" },
        { sub: "apparent_temperature", val: b.current.apparent_temperature, unit: "°C", label: "Apparent (feels-like) temperature" },
        { sub: "precipitation", val: b.current.precipitation, unit: "mm", label: "Precipitation" },
        { sub: "weather_code", val: b.current.weather_code, unit: "wmo", label: "WMO weather code" },
        { sub: "wind_speed_10m", val: b.current.wind_speed_10m, unit: "km/h", label: "Wind speed (10 m)" },
        { sub: "wind_gusts_10m", val: b.current.wind_gusts_10m, unit: "km/h", label: "Wind gusts (10 m) — spray-drift and lodging relevance" },
        { sub: "cloud_cover", val: b.current.cloud_cover, unit: "%", label: "Cloud cover" },
        { sub: "surface_pressure", val: b.current.surface_pressure, unit: "hPa", label: "Surface pressure" },
        { sub: "vapour_pressure_deficit", val: b.current.vapour_pressure_deficit, unit: "kPa", label: "Vapour pressure deficit (VPD)" },
      ];
      for (const r of rows) {
        if (r.val === null) continue;
        addEvidence(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId,
          domain: "weather",
          source: "Open-Meteo",
          source_type: "open-meteo",
          sub_type: `current_${r.sub}`,
          measurement: r.label,
          value: r.val,
          unit: r.unit,
          state: "PREDICTED", // model nowcast — NOT a physical sensor observation
          observed_at: b.current.time,
          retrieved_at: retrieved,
          description: "Open-Meteo model nowcast for the current hour (not a field sensor observation).",
          provenance: {
            provider: "openmeteo",
            model: "Open-Meteo forecast blend",
            processing: "point retrieval at field centroid",
            note: b.note,
          },
        });
        inserted++;
      }
    }

    for (const day of b.daily) {
      const isFuture = day.date >= new Date().toISOString().slice(0, 10);
      const state = isFuture ? "PREDICTED" : "HISTORICAL";
      const dayRows: { sub: string; val: number | null; unit: string; label: string }[] = [
        { sub: "temperature_2m_max", val: day.temperature_2m_max, unit: "°C", label: "Max air temperature" },
        { sub: "temperature_2m_min", val: day.temperature_2m_min, unit: "°C", label: "Min air temperature" },
        { sub: "temperature_2m_mean", val: day.temperature_2m_mean, unit: "°C", label: "Mean air temperature" },
        { sub: "precipitation_sum", val: day.precipitation_sum, unit: "mm", label: "Precipitation total" },
        { sub: "precipitation_hours", val: day.precipitation_hours, unit: "hr", label: "Hours of precipitation" },
        { sub: "et0_fao_evapotranspiration", val: day.et0_fao_evapotranspiration, unit: "mm", label: "Reference evapotranspiration (FAO ET0)" },
        { sub: "precipitation_probability_max", val: day.precipitation_probability_max, unit: "%", label: "Precipitation probability" },
        { sub: "shortwave_radiation_sum", val: day.shortwave_radiation_sum, unit: "MJ/m²", label: "Solar radiation total (shortwave)" },
        {
          sub: "sunshine_duration",
          // provider reports seconds; stored in hours and said so (no silent unit change)
          val: day.sunshine_duration === null ? null : Math.round((day.sunshine_duration / 3600) * 10) / 10,
          unit: "hr",
          label: "Sunshine duration (converted from provider seconds)",
        },
        { sub: "uv_index_max", val: day.uv_index_max, unit: "index", label: "Max UV index" },
        { sub: "wind_gusts_10m_max", val: day.wind_gusts_10m_max, unit: "km/h", label: "Max wind gusts" },
      ];
      for (const r of dayRows) {
        if (r.val === null) continue;
        addEvidence(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId,
          domain: "weather",
          source: "Open-Meteo",
          source_type: "open-meteo",
          sub_type: r.sub,
          measurement: r.label,
          value: r.val,
          unit: r.unit,
          state,
          observed_at: `${day.date}T00:00:00.000Z`,
          retrieved_at: retrieved,
          description:
            state === "PREDICTED"
              ? "Model forecast day. Not an observation."
              : "Model reanalysis / historical day (ERA5-based). Not a physical observation.",
          provenance: {
            provider: "openmeteo",
            model: state === "PREDICTED" ? "Open-Meteo forecast" : "Open-Meteo historical (reanalysis blend)",
            processing: "point retrieval at field centroid",
            note: b.note,
          },
        });
        inserted++;
      }
    }

    // ---- modelled root-zone soil moisture (free, key-less) -----------------
    // Land-surface MODEL output in three real depth layers. Stored PREDICTED and
    // never allowed to stand in for a probe reading.
    const smRes = await runProvider(
      { db },
      "openmeteo",
      () => getSoilMoistureNow(field.centroid_lat, field.centroid_lon).then((d) => ({ data: d })),
      { timeoutMs: 20_000, retries: 1 },
    );
    if (smRes.status === "AVAILABLE" && smRes.data) {
      const sm = smRes.data;
      for (const layer of sm.layers) {
        if (layer.value === null) continue;
        addEvidence(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId,
          domain: "soil",
          source: "Open-Meteo",
          source_type: "open-meteo",
          sub_type: `modelled_volumetric_water_${layer.depth}`,
          measurement: `Modelled soil moisture (${layer.depth})`,
          value: layer.value,
          unit: "m³/m³",
          state: "PREDICTED",
          observed_at: sm.time ?? now,
          retrieved_at: retrieved,
          description: sm.note,
          provenance: {
            provider: "openmeteo",
            model: "Open-Meteo land-surface soil moisture",
            processing: "point retrieval at field centroid, hour matched to now",
          },
        });
        inserted++;
      }
      publishEvent(db, {
        type: "SOIL_MOISTURE_UPDATED",
        user_id: field.user_id,
        farm_id: field.farm_id,
        field_id: fieldId,
        payload: { layers: sm.layers.length, state: "PREDICTED" },
      });
    }

    // ---- air quality / particulate load (same provider, no key) -----------
    // Real atmospheric-model values. Farming-relevant: dust load bears on spray
    // drift and residue-burning questions, and on field-worker exposure.
    const aqRes = await runProvider(
      { db },
      "openmeteo",
      () => getAirQualityNow(field.centroid_lat, field.centroid_lon).then((d) => ({ data: d })),
      { timeoutMs: 20_000, retries: 1 },
    );
    if (aqRes.status === "AVAILABLE" && aqRes.data) {
      const aq = aqRes.data;
      const aqRows: { sub: string; val: number | null; unit: string; label: string }[] = [
        { sub: "air_quality_pm2_5", val: aq.pm2_5, unit: "μg/m³", label: "PM2.5 particulate (model)" },
        { sub: "air_quality_pm10", val: aq.pm10, unit: "μg/m³", label: "PM10 particulate (model)" },
        { sub: "air_quality_dust", val: aq.dust, unit: "μg/m³", label: "Dust load (model)" },
        { sub: "air_quality_us_aqi", val: aq.us_aqi, unit: "USAQI", label: "US air quality index" },
        { sub: "air_quality_european_aqi", val: aq.european_aqi, unit: "EAQI", label: "European air quality index" },
      ];
      for (const r of aqRows) {
        if (r.val === null) continue;
        addEvidence(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId,
          domain: "environment",
          source: "Open-Meteo",
          source_type: "open-meteo",
          sub_type: r.sub,
          measurement: r.label,
          value: r.val,
          unit: r.unit,
          state: "PREDICTED",
          observed_at: aq.time ?? now,
          retrieved_at: retrieved,
          description: aq.note,
          provenance: {
            provider: "openmeteo",
            model: "CAMS via Open-Meteo air-quality API",
            processing: "point retrieval at field centroid",
          },
        });
        inserted++;
      }
    }

    publishEvent(db, {
      type: "WEATHER_UPDATED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: { inserted, state: "PREDICTED/HISTORICAL model rows", note: "weather from Open-Meteo model — never presented as sensor data" },
    });
  });
}

// ---------------------------------------------------------------------------
// Satellite discovery (STAC metadata)
// ---------------------------------------------------------------------------
export async function refreshSatellite(db: AppDb, fieldId: string): Promise<void> {
  const field = getFieldRow(db, fieldId);
  if (!field) return;
  await runJobGuarded(db, { type: "SATELLITE_DISCOVERY", fieldId, userId: field.user_id }, async () => {
    // full ISO-8601 datetimes (STAC rejects date-only strings in the datetime param)
    const from = new Date(Date.now() - config.satelliteSearchDaysBack * 86_400_000).toISOString();
    const to = new Date().toISOString();
    // Optical + SAR + Landsat in one catalog search. Cloud cover is kept in the
    // metadata (no silent filtering): the UI reports it honestly and the
    // best-qualified card picks the clearest scene.
    const res = await runProvider(
      { db },
      "copernicus",
      () =>
        searchStac({
          bbox: aoiBbox(field.geometry),
          from,
          to,
          collectionKeys: [...DEFAULT_DISCOVERY_COLLECTIONS],
          maxCloud: 100,
          limit: 60,
        }).then((d) => ({
          data: d,
        })),
      { timeoutMs: 30_000, retries: 1 },
    );
    if (res.status !== "AVAILABLE" || !res.data) {
      throw new Error(`Satellite discovery unavailable: ${res.status} ${res.error ?? ""}`);
    }
    let added = 0;
    const byCollection = new Map<string, number>();
    for (const p of res.data) {
      // per-field dedupe: the same Sentinel scene legitimately covers multiple
      // fields, so a product is only a duplicate within this field's catalog
      const existing = db.conn.query("SELECT id FROM satellite_products WHERE field_id = ? AND product_id = ?").get(fieldId, p.product_id);
      if (existing) continue;
      db.conn
        .query(
          `INSERT INTO satellite_products
           (id, user_id, farm_id, field_id, provider, satellite, product_id, collection, acquired_at, cloud_cover, resolution_m, processing_level,
            geometry, assets, platform, orbit_relative, polarization, product_type, preview_available, state, status, source_url, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'OBSERVED','discovered',?,?)`,
        )
        .run(
          `sat_${p.product_id.slice(0, 32)}_${fieldId.slice(-8)}`,
          field.user_id,
          field.farm_id,
          fieldId,
          "copernicus",
          p.satellite,
          p.product_id,
          p.collection,
          p.acquired_at,
          p.cloud_cover,
          p.resolution_m,
          p.processing_level,
          p.geometry ? JSON.stringify(p.geometry) : null,
          JSON.stringify(p.assets),
          p.platform,
          p.orbit_relative,
          p.polarization,
          p.product_type,
          p.source_url,
          nowIso(),
        );
      added++;
      byCollection.set(p.collection, (byCollection.get(p.collection) ?? 0) + 1);
    }
    publishEvent(db, {
      type: "SATELLITE_UPDATED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: {
        added,
        by_collection: Object.fromEntries(byCollection),
        note:
          added === 0
            ? "Discovery ran but no new acquisitions found in the search window (NO_DATA for new items)."
            : `${added} new acquisition(s) discovered across ${[...byCollection.keys()].join(", ")} (metadata only; raster access AUTH_REQUIRED).`,
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Soil (SoilGrids model estimates)
// ---------------------------------------------------------------------------
export async function refreshSoil(db: AppDb, fieldId: string): Promise<void> {
  const field = getFieldRow(db, fieldId);
  if (!field) return;
  await runJobGuarded(db, { type: "SOIL_REFRESH", fieldId, userId: field.user_id }, async () => {
    const res = await runProvider(
      { db },
      "soilgrids",
      () => getSoilProperties(field.centroid_lon, field.centroid_lat).then((rows) => ({ data: rows })),
      { timeoutMs: 30_000, retries: 1 },
    );
    let usable: SoilPropertyRow[] = [];
    let viaWcs = false;
    if (res.status === "AVAILABLE" && res.data) {
      usable = res.data.filter((row) => row.mean !== null);
    }
    if (usable.length === 0) {
      // SoilGrids REST is paused by ISRIC (timeout / all-null responses). Fall
      // back to the still-live keyless SoilGrids WCS map server (maps.isric.org)
      // — the same v2.0 250 m model, served as coverages over the field bbox.
      const wcs = await runProvider(
        { db },
        "soilgrids",
        () => getSoilPropertiesWcs(field.centroid_lat, field.centroid_lon).then((rows) => ({ data: rows })),
        { timeoutMs: 180_000, retries: 0 },
      );
      if (wcs.status === "AVAILABLE" && wcs.data) {
        usable = wcs.data.filter((row) => row.mean !== null);
        if (usable.length > 0) {
          viaWcs = true;
          recordHealth(
            db,
            "soilgrids",
            "AVAILABLE",
            wcs.latencyMs,
            "SoilGrids REST paused by ISRIC; serving real v2.0 250 m model data via the public WCS map server (maps.isric.org), including a real depth profile (texture, organic carbon and bulk density at 0-5 / 5-15 / 15-30 / 30-60 cm). Values are ESTIMATED model data, not field measurements.",
          );
        }
      }
    }
    if (usable.length === 0) {
      // No real soil values from either the REST API or the WCS fallback.
      // Record DATA_QUALITY_FAILURE truthfully and keep existing soil evidence
      // rather than deleting it on a broken refresh.
      const restNote =
        res.status !== "AVAILABLE" ? `SoilGrids REST: ${res.status} ${res.error ?? ""}` : "SoilGrids REST returned no usable values (ISRIC has paused the REST service)";
      const msg = `${restNote}; WCS fallback also yielded no usable cells. Recorded DATA_QUALITY_FAILURE. Existing soil evidence was kept.`;
      recordHealth(db, "soilgrids", "DATA_QUALITY_FAILURE", res.latencyMs, msg);
      throw new Error(msg);
    }
    // Replace the previous SoilGrids estimate batch (only after a usable
    // response). Scoped to the SoilGrids rows this step owns: the soil domain
    // also carries model-derived soil moisture written by the weather step, and
    // a domain-wide delete here silently wiped it on every pipeline run.
    db.conn.query("DELETE FROM evidence WHERE field_id = ? AND domain = 'soil' AND sub_type NOT LIKE 'modelled_%'").run(fieldId);
    let inserted = 0;
    for (const row of usable) {
      if (row.mean === null) continue;
      const isPh = row.property === "phh2o";
      const value = isPh ? round(row.mean / 10, 2) : round(row.mean, 1);
      const unit = isPh ? "pH" : row.unit;
      const sub = isPh ? `ph@${row.depth}` : `${row.property}@${row.depth}`;
      addEvidence(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        domain: "soil",
        source: viaWcs ? "ISRIC SoilGrids v2.0 (WCS 250 m)" : "ISRIC SoilGrids v2.0",
        source_type: "soilgrids",
        sub_type: sub,
        measurement: isPh ? "pH (H2O, model estimate)" : `Soil property ${row.property} (model estimate)`,
        value,
        unit,
        state: "ESTIMATED",
        observed_at: nowIso(),
        retrieved_at: nowIso(),
        description: viaWcs
          ? `SoilGrids v2.0 global 250 m model — mean of the valid WCS cells in the field neighbourhood (~3 km box) at depth ${row.depth}. Uncertainty not provided on the WCS fallback (per-pixel Q0.05/Q0.95 rasters exist for spread). NOT a field measurement.`
          : `SoilGrids v2.0 global model estimate at depth ${row.depth}; uncertainty ±${row.uncertainty ?? "n/a"} ${row.unit}. Not a field measurement.`,
        provenance: {
          provider: "soilgrids",
          model: viaWcs ? "SoilGrids v2.0 (WCS tiles, 250 m)" : "SoilGrids v2.0",
          processing: viaWcs
            ? `mean of valid 250 m WCS cells in a ~3 km box around centroid (${round(field.centroid_lat, 4)}, ${round(field.centroid_lon, 4)}) depth ${row.depth}`
            : `point query at centroid (${round(field.centroid_lat, 4)}, ${round(field.centroid_lon, 4)}) depth ${row.depth}`,
          access_url: viaWcs ? "https://maps.isric.org/mapserv (WCS, keyless)" : `${config.soilgridsBaseUrl}/properties/query`,
        },
      });
      inserted++;
    }
    publishEvent(db, {
      type: "EVIDENCE_ADDED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: { domain: "soil", inserted, state: "ESTIMATED" },
    });
  });
}

// ---------------------------------------------------------------------------
// Water (keyless open spatial dataset: OpenStreetMap water features)
// ---------------------------------------------------------------------------
export async function refreshWater(db: AppDb, fieldId: string): Promise<void> {
  const field = getFieldRow(db, fieldId);
  if (!field) return;
  await runJobGuarded(db, { type: "WATER_REFRESH", fieldId, userId: field.user_id }, async () => {
    const res = await runProvider(
      { db },
      "osm-water",
      () => getWaterFeatures(field.centroid_lat, field.centroid_lon).then((d) => ({ data: d })),
      { timeoutMs: 30_000, retries: 1 },
    );
    if (res.status !== "AVAILABLE" || !res.data) {
      throw new Error(`Water (OSM) provider unavailable: ${res.status} ${res.error ?? ""}`);
    }
    const w = res.data;
    // replace only the rows this open-dataset refresh owns
    db.conn.query("DELETE FROM evidence WHERE field_id = ? AND domain = 'water' AND source_type = 'osm-water'").run(fieldId);
    let inserted = 0;

    // nearest mapped water feature (distance to feature center — approximation)
    if (w.nearest) {
      addEvidence(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        domain: "water",
        source: "OpenStreetMap (Overpass API)",
        source_type: "osm-water",
        sub_type: "nearest_water_distance_km",
        measurement: "Distance to nearest mapped water feature",
        value: w.nearest.distance_km,
        unit: "km",
        state: "DERIVED", // map dataset, not an in-situ measurement
        observed_at: nowIso(),
        retrieved_at: nowIso(),
        description: `Nearest mapped ${w.nearest.kind} is ${w.nearest.type}${w.nearest.name ? ` (“${w.nearest.name}”)` : ""} at ${w.nearest.distance_km} km (distance to feature center). ${w.note}`,
        provenance: {
          provider: "osm-water",
          model: "OpenStreetMap vector dataset",
          processing: `Overpass around(${round(field.centroid_lat, 5)}, ${round(field.centroid_lon, 5)}, 6000 m)`,
          access_url: w.endpoint ?? osmWaterDatasetProvenance.endpoints[0],
          note: `${osmWaterDatasetProvenance.license} · dataset_state ${osmWaterDatasetProvenance.dataset_state}. Served by Overpass endpoint ${w.endpoint ?? "?"}. Presence of a mapped water feature — not a flow or depth measurement.`,
        },
      });
      inserted++;
    }
    // feature counts (derived from the dataset)
    addEvidence(db, {
      userId: field.user_id,
      farmId: field.farm_id,
      fieldId,
      domain: "water",
      source: "OpenStreetMap (Overpass API)",
      source_type: "osm-water",
      sub_type: "mapped_water_features_6km",
      measurement: "Mapped water features within 6 km",
      value: w.total,
      unit: "features",
      state: "DERIVED",
      observed_at: nowIso(),
      retrieved_at: nowIso(),
      description: `${w.total} mapped water feature(s) within ${w.searched_radius_km} km (${w.within_1km} within 1 km). ${w.note}`,
      provenance: {
        provider: "osm-water",
        model: "OpenStreetMap vector dataset",
        processing: `Overpass around(${round(field.centroid_lat, 5)}, ${round(field.centroid_lon, 5)}, 6000 m)`,
        access_url: w.endpoint ?? osmWaterDatasetProvenance.endpoints[0],
        note: `${osmWaterDatasetProvenance.license} · dataset_state ${osmWaterDatasetProvenance.dataset_state}. Served by Overpass endpoint ${w.endpoint ?? "?"}. Coverage varies by region; absence in OSM is not proof of absence on the ground.`,
      },
    });
    inserted++;

    publishEvent(db, {
      type: "EVIDENCE_ADDED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: { domain: "water", inserted, state: "DERIVED", source: "osm-water" },
    });
  });
}

// ---------------------------------------------------------------------------
// Terrain — real DEM grid sampling (SRTM 90 m → ASTER 30 m), with an honest
// single-point Open-Meteo fallback when the DEM datasets are unreachable.
// ---------------------------------------------------------------------------

/**
 * Target DEM sample spacing in metres. ASTER GDEM is 30 m; SRTM is 90 m. The
 * previous fixed 3×3 grid left ~200 m between samples on a 32 ha field, which
 * is coarser than the raster itself and made the twin surface effectively flat.
 */
const DEM_TARGET_SPACING_M = 30;
/**
 * Cap on grid divisions per axis → at most 256 locations, i.e. at most 3
 * OpenTopoData requests (100 locations each). Bounds the per-refresh cost for
 * very large fields without needing a per-field setting.
 */
const DEM_MAX_GRID_AXIS = 16;

export async function refreshTerrain(db: AppDb, fieldId: string): Promise<void> {
  const field = getFieldRow(db, fieldId);
  if (!field) return;
  await runJobGuarded(db, { type: "TERRAIN_REFRESH", fieldId, userId: field.user_id }, async () => {
    // Divisions are sized per axis so the spacing stays near the DEM's own
    // resolution on both axes (a square grid over a 2:1 bbox halves it).
    const { nx, ny } = demGridDivisions(field.geometry, DEM_TARGET_SPACING_M, DEM_MAX_GRID_AXIS);
    const pts = samplePointsInside(field.geometry, nx, ny);
    if (pts.length === 0) throw new Error("Cannot sample terrain: no grid points inside the field polygon");

    // Primary path: real DEM raster samples (SRTM 90 m, falls back to ASTER 30 m).
    const dem = await runProvider(
      { db },
      "opentopodata",
      () => getDemSamples(pts.map((p) => ({ lat: p.lat, lon: p.lon }))).then((d) => ({ data: d })),
      { timeoutMs: 25_000, retries: 1 },
    );

    if (dem.status === "AVAILABLE" && dem.data && dem.data.samples.length > 0) {
      const dataset = dem.data.dataset.toUpperCase();
      const samples = dem.data.samples.filter((s) => s.elevation_m_raw !== null);
      if (samples.length === 0) throw new Error("DEM provider returned no usable elevation cells");
      deleteEvidenceWhere(db, fieldId, "terrain");
      const t = nowIso();
      const stats = deriveTerrainStats(samples);

      // The whole DEM grid is ONE evidence row rather than one row per sample:
      // a 100+ point grid would flood the evidence list, evict the summary rows
      // the twin reads (terrain is fetched with a LIMIT), and make the terrain
      // domain's evidence count read as "hundreds of observations" when it is
      // really a single provider response. GeoJSON MultiPoint carries each
      // sample's real elevation as its third ordinate, so the grid is still a
      // single, standards-shaped spatial geometry.
      addEvidence(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        domain: "terrain",
        source: `OpenTopoData ${dataset} DEM`,
        source_type: `dem-${dem.data.dataset}`,
        sub_type: "dem_grid",
        measurement: `DEM sample grid (${samples.length} points)`,
        value: stats.mean_m,
        unit: "m",
        state: "DERIVED",
        observed_at: t,
        geometry: {
          type: "MultiPoint",
          coordinates: samples.map((s) => [s.lon, s.lat, s.elevation_m_raw as number]),
        },
        description: `Real ${dataset} DEM raster cells sampled on a ${nx}×${ny} grid clipped to the field polygon (${samples.length} points inside). Each coordinate triple is lon, lat, elevation — DERIVED raster cell values, never survey measurements.`,
        provenance: {
          provider: "opentopodata",
          model: dem.data.dataset === "srtm90m" ? "NASA SRTM v4.1 (90 m)" : "ASTER GDEM v3 (30 m)",
          processing: `OpenTopoData raster samples via ${dem.data.endpoint} on a ${nx}×${ny} grid (~${DEM_TARGET_SPACING_M} m target spacing, ≤${DEM_MAX_GRID_AXIS} divisions/axis) in ${dem.data.requests} batched request(s)`,
          access_url: dem.data.endpoint,
          note: `${opentopodataProvenance.license} · dataset_state ${opentopodataProvenance.dataset_state}`,
        },
      });

      // summary rows (DERIVED statistics over the real samples)
      const summary: { sub: string; measurement: string; value: number; note: string }[] = [
        { sub: "elevation_min_m", measurement: "Minimum elevation (DEM grid)", value: stats.min_m, note: `Minimum of ${stats.sample_count} real DEM samples inside the field.` },
        { sub: "elevation_max_m", measurement: "Maximum elevation (DEM grid)", value: stats.max_m, note: `Maximum of ${stats.sample_count} real DEM samples inside the field.` },
        { sub: "elevation_mean_m", measurement: "Mean elevation (DEM grid)", value: stats.mean_m, note: `Mean of ${stats.sample_count} real DEM samples inside the field.` },
        { sub: "elevation_range_m", measurement: "Elevation range (DEM grid)", value: stats.range_m, note: "max − min over the real DEM samples." },
      ];
      if (stats.slope_degrees !== null) {
        summary.push({ sub: "slope_degrees", measurement: "Slope (DERIVED from DEM grid)", value: stats.slope_degrees, note: stats.method });
        summary.push({ sub: "aspect_degrees", measurement: "Aspect (DERIVED from DEM grid)", value: stats.aspect_degrees ?? 0, note: "0=N, 90=E, 180=S, 270=W (downslope). " + stats.method });
      }
      for (const s of summary) {
        addEvidence(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId,
          domain: "terrain",
          source: `OpenTopoData ${dataset} DEM`,
          source_type: `dem-${dem.data.dataset}`,
          sub_type: s.sub,
          measurement: s.measurement,
          value: s.value,
          unit: s.sub.includes("slope") || s.sub.includes("aspect") ? "deg" : "m",
          state: "DERIVED",
          observed_at: t,
          description: `${s.note} ${stats.method}`,
          provenance: {
            provider: "opentopodata",
            model: dem.data.dataset === "srtm90m" ? "NASA SRTM v4.1 (90 m)" : "ASTER GDEM v3 (30 m)",
            processing: s.sub.includes("slope") || s.sub.includes("aspect") ? "slope/aspect derived from DEM sample grid (method in description)" : `statistics over ${stats.sample_count} DEM samples`,
            access_url: dem.data.endpoint,
            note: `${opentopodataProvenance.license} · dataset_state ${opentopodataProvenance.dataset_state}`,
          },
        });
      }
      // sample count as evidence (count is real)
      addEvidence(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        domain: "terrain",
        source: `OpenTopoData ${dataset} DEM`,
        source_type: `dem-${dem.data.dataset}`,
        sub_type: "dem_sample_count",
        measurement: "DEM samples inside field",
        value: stats.sample_count,
        unit: null,
        state: "DERIVED",
        observed_at: t,
        description: `Number of real DEM raster samples used for the terrain layer (grid points inside the field polygon).`,
        provenance: { provider: "opentopodata", model: dem.data.dataset === "srtm90m" ? "NASA SRTM v4.1 (90 m)" : "ASTER GDEM v3 (30 m)", processing: "grid sampling inside field polygon", access_url: dem.data.endpoint, note: opentopodataProvenance.license },
      });
      publishEvent(db, {
        type: "EVIDENCE_ADDED",
        user_id: field.user_id,
        farm_id: field.farm_id,
        field_id: fieldId,
        payload: { domain: "terrain", state: "DERIVED", dataset: dem.data.dataset, samples: stats.sample_count, slope: stats.slope_degrees },
      });
      return;
    }

    // Fallback: single centroid elevation from Open-Meteo — honestly labelled
    // as a centroid point; slope/aspect stay UNKNOWN (no DEM grid).
    const res = await runProvider(
      { db },
      "openmeteo",
      () => getElevation(field.centroid_lat, field.centroid_lon).then((d) => ({ data: d })),
      { timeoutMs: 15_000 },
    );
    if (res.status !== "AVAILABLE" || !res.data) {
      throw new Error(`Terrain providers unavailable (DEM: ${dem.status} ${dem.error ?? ""}; elevation: ${res.status} ${res.error ?? ""})`);
    }
    deleteEvidenceWhere(db, fieldId, "terrain");
    if (res.data.elevation === null) throw new Error("Elevation response missing elevation value");
    addEvidence(db, {
      userId: field.user_id,
      farmId: field.farm_id,
      fieldId,
      domain: "terrain",
      source: "Open-Meteo elevation API (centroid point)",
      source_type: "open-meteo-elevation",
      sub_type: "elevation_m",
      measurement: "Centroid elevation (fallback)",
      value: res.data.elevation,
      unit: "m",
      state: "DERIVED",
      observed_at: nowIso(),
      retrieved_at: nowIso(),
      description: "CENTROID ELEVATION only (single point). Real DEM grids (SRTM/ASTER) were unreachable — slope/aspect are UNKNOWN, not estimated.",
      provenance: {
        provider: "openmeteo",
        model: "DEM (Open-Meteo elevation service)",
        processing: "point query at field centroid (fallback after DEM datasets unavailable)",
      },
    });
    publishEvent(db, {
      type: "EVIDENCE_ADDED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: { domain: "terrain", state: "DERIVED", fallback: "open-meteo-centroid" },
    });
  });
}

// ---------------------------------------------------------------------------
// World model + intelligence update after evidence changes
// ---------------------------------------------------------------------------
export async function updateWorldModelAndIntelligence(db: AppDb, fieldId: string, trigger: string): Promise<{ changed: boolean; wmId: string | null }> {
  const field = getFieldRow(db, fieldId);
  if (!field) return { changed: false, wmId: null };
  const before = latestWorldModel(db, fieldId);
  const composed = composeWorldModel(db, fieldId);
  const wmId = saveWorldModelSnapshot(db, fieldId, trigger, composed.snapshot);

  // Compare content (state/latest evidence/count per domain) to detect real change
  let meaningfulChange = false;
  const prevSnapshot = before?.snapshot ?? null;
  if (!prevSnapshot) {
    meaningfulChange = true;
  } else {
    const prevDomains = (prevSnapshot as { domains?: { domain: string; state: string; latest_evidence_id: string | null; count: number }[] }).domains ?? [];
    const prevMap = new Map(prevDomains.map((d) => [d.domain, `${d.state}:${d.latest_evidence_id ?? ""}:${d.count}`]));
    for (const d of composed.domains) {
      if (prevMap.get(d.domain) !== `${d.state}:${d.latest_evidence_id ?? ""}:${d.count}`) meaningfulChange = true;
    }
  }

  if (meaningfulChange) {
    publishEvent(db, {
      type: "WORLD_MODEL_UPDATED",
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      payload: { world_model_id: wmId, trigger },
    });
    // Farm Memory: record the actual change (no synthetic history)
    const changedDomains = composed.domains.filter((d) => {
      const prev = prevSnapshot
        ? (prevSnapshot as { domains?: { domain: string; state: string; latest_evidence_id: string | null; count: number }[] }).domains?.find((p) => p.domain === d.domain)
        : undefined;
      return prev === undefined || prev.state !== d.state || prev.latest_evidence_id !== d.latest_evidence_id || prev.count !== d.count;
    });
    for (const d of changedDomains) {
      addMemory(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        kind: "world_model_change",
        title: `World model updated (${d.domain})`,
        summary: `${d.domain} state is now ${d.state} (evidence count ${d.count}). Trigger: ${trigger}.`,
        refId: wmId,
      });
    }
  }

  const report = runIntelligence(db, fieldId);
  publishEvent(db, {
    type: "RISK_UPDATED",
    user_id: field.user_id,
    farm_id: field.farm_id,
    field_id: fieldId,
    payload: { risks: report.risks, anomalies: report.anomalies, uncertainties: report.uncertainties, contradictions: report.contradictions },
  });
  return { changed: meaningfulChange, wmId };
}

/** Full field refresh used by both the scheduler and the RUN NOW endpoint. */
export async function runFullFieldRefresh(db: AppDb, fieldId: string): Promise<{ jobs: string[] }> {
  await refreshWeather(db, fieldId);
  await refreshSatellite(db, fieldId);
  await refreshSoil(db, fieldId);
  await refreshTerrain(db, fieldId);
  await refreshWater(db, fieldId);
  await updateWorldModelAndIntelligence(db, fieldId, "FIELD_REFRESH");
  return { jobs: [] };
}
