import type { Domain, FieldRecord, TruthState, WorldModelDomainState } from "contracts";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonParse, jsonStringify, newId, sha1hex } from "../util";
import { evidenceCountByDomain, latestEvidencePerSubtype } from "./evidence";

export interface FieldWithOwners extends FieldRecord {
  farm_name: string | null;
}

export function getFieldRow(db: AppDb, fieldId: string): FieldWithOwners | null {
  const row = db.conn
    .query(
      `SELECT f.*, farm.name as farm_name FROM fields f LEFT JOIN farms farm ON farm.id = f.farm_id WHERE f.id = ?`,
    )
    .get(fieldId) as (FieldWithOwners & { geometry: string; bbox: string }) | undefined;
  if (!row) return null;
  const { geometry, bbox, ...rest } = row;
  return { ...rest, geometry: JSON.parse(geometry), bbox: JSON.parse(bbox) } as FieldWithOwners;
}

function compactEvidence(db: AppDb, fieldId: string, domain: Domain, limitSubtypes = 8) {
  const rows = db.conn
    .query(
      `SELECT e.* FROM evidence e
       WHERE e.field_id = ? AND e.domain = ?
       ORDER BY e.observed_at DESC LIMIT ?`,
    )
    .all(fieldId, domain, String(200)) as unknown as {
    id: string;
    sub_type: string;
    value: number | null;
    unit: string | null;
    state: string;
    observed_at: string;
    retrieved_at: string;
    source: string;
    source_type: string;
    quality: string | null;
  }[];
  // latest per sub_type
  const perType = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (!perType.has(r.sub_type)) perType.set(r.sub_type, r);
  }
  return [...perType.values()]
    .slice(0, limitSubtypes)
    .map((r) => ({
      evidence_id: r.id,
      sub_type: r.sub_type,
      value: r.value,
      unit: r.unit,
      state: r.state,
      source: r.source_type,
      observed_at: r.observed_at,
    }));
}

function satelliteState(db: AppDb, fieldId: string): WorldModelDomainState["entries"] {
  const rows = db.conn
    .query(
      `SELECT product_id, satellite, acquired_at, cloud_cover, resolution_m, processing_level, state, status
       FROM satellite_products WHERE field_id = ? ORDER BY acquired_at DESC LIMIT 12`,
    )
    .all(fieldId) as {
    product_id: string;
    satellite: string;
    acquired_at: string;
    cloud_cover: number | null;
    resolution_m: number | null;
    processing_level: string | null;
    state: string;
    status: string;
  }[];
  return rows.map((r) => ({ product_id: r.product_id, satellite: r.satellite, acquired_at: r.acquired_at, cloud_cover: r.cloud_cover, state: r.state }));
}

function sensorState(db: AppDb, fieldId: string): { entries: unknown[]; devices: unknown[] } {
  const obs = db.conn
    .query(
      `SELECT sensor_type, COUNT(*) as n, MAX(observed_at) as last_at, MAX(value) as max_v, MIN(value) as min_v
       FROM observations WHERE field_id = ? GROUP BY sensor_type`,
    )
    .all(fieldId) as { sensor_type: string; n: number; last_at: string | null; max_v: number; min_v: number }[];
  const devices = db.conn
    .query("SELECT id, name, kind, status, last_seen_at, firmware_version FROM devices WHERE field_id = ?")
    .all(fieldId) as { id: string; name: string; kind: string; status: string; last_seen_at: string | null; firmware_version: string | null }[];
  return {
    entries: obs.map((o) => ({
      sensor_type: o.sensor_type,
      observations: o.n,
      last_at: o.last_at,
      min: o.min_v,
      max: o.max_v,
      state: o.n > 0 ? "OBSERVED" : "NO_DATA",
    })),
    devices,
  };
}

function waterState(db: AppDb, fieldId: string) {
  // water evidence is separate from terrain/soil by construction
  return compactEvidence(db, fieldId, "water", 6);
}

export function listActiveFields(db: AppDb, userId?: string): FieldWithOwners[] {
  const rows = (userId
    ? db.conn
        .query("SELECT f.*, farm.name as farm_name FROM fields f LEFT JOIN farms farm ON farm.id = f.farm_id WHERE f.user_id = ? ORDER BY f.created_at")
        .all(userId)
    : db.conn
        .query("SELECT f.*, farm.name as farm_name FROM fields f LEFT JOIN farms farm ON farm.id = f.farm_id ORDER BY f.created_at")
        .all()) as unknown as (FieldWithOwners & { geometry: string; bbox: string })[];
  return rows.map(({ geometry, bbox, ...rest }) => ({
    ...rest,
    geometry: JSON.parse(geometry),
    bbox: JSON.parse(bbox),
  })) as unknown as FieldWithOwners[];
}

function freshnessLevel(db: AppDb, fieldId: string, domain: Domain, maxAgeHours: number): { level: "LOW" | "MEDIUM" | "HIGH"; reason: string } {
  let lastRetrieved: string | null = null;
  if (domain === "satellite") {
    const row = db.conn
      .query("SELECT MAX(acquired_at) as last FROM satellite_products WHERE field_id = ?")
      .get(fieldId) as { last: string | null } | undefined;
    lastRetrieved = row?.last ?? null;
  } else {
    const row = db.conn
      .query("SELECT MAX(retrieved_at) as last_retrieved FROM evidence WHERE field_id = ? AND domain = ?")
      .get(fieldId, domain) as { last_retrieved: string | null } | undefined;
    lastRetrieved = row?.last_retrieved ?? null;
  }
  const domains: Record<Domain, string> = {
    sensor: "sensor observations",
    satellite: "satellite acquisitions",
    weather: "weather records",
    water: "water evidence",
    soil: "soil evidence",
    terrain: "terrain evidence",
    crop: "crop evidence",
    farmer: "farmer observations",
    history: "history",
    simulation: "simulation",
    environment: "environment",
  };
  const label = domains[domain] ?? domain;
  if (!lastRetrieved) {
    return { level: "HIGH", reason: `No ${label} have ever been recorded for this field.` };
  }
  const ageHours = (Date.now() - new Date(lastRetrieved).getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return { level: "HIGH", reason: `Last ${label} retrieval is ${Math.round(ageHours)}h old (max ${maxAgeHours}h for freshness).` };
  }
  if (ageHours > maxAgeHours / 2) {
    return { level: "MEDIUM", reason: `Last ${label} retrieval is ${Math.round(ageHours)}h old.` };
  }
  return { level: "LOW", reason: `${label} are fresh (${Math.round(ageHours)}h).` };
}

/** Build the current world model of a field (never overwrites history). */
export function composeWorldModel(db: AppDb, fieldId: string): { domains: WorldModelDomainState[]; snapshot: Record<string, unknown> } {
  const field = getFieldRow(db, fieldId);
  const counts = evidenceCountByDomain(db, fieldId);

  const latest = latestEvidencePerSubtype(db, fieldId);
  const satellites = db.conn
    .query("SELECT COUNT(*) as n, MAX(acquired_at) as last FROM satellite_products WHERE field_id = ?")
    .get(fieldId) as { n: number; last: string | null };
  const sensor = sensorState(db, fieldId);

  const domainOf = (domain: Domain, entries: unknown[], state: WorldModelDomainState["state"], summary: string): WorldModelDomainState => ({
    domain,
    state,
    latest_evidence_id: null,
    latest_at: null,
    count: counts[domain] ?? 0,
    summary,
    entries,
  });

  const domains: WorldModelDomainState[] = [];

  // --- weather
  const wEntry = latest.get("weather:current_temperature");
  const weatherEntries = compactEvidence(db, fieldId, "weather", 10);
  domains.push(
    domainOf(
      "weather",
      weatherEntries,
      weatherEntries.length ? "PARTIAL" : "NO_DATA",
      weatherEntries.length
        ? `Weather evidence present (${weatherEntries.length} variable types). Source: Open-Meteo model (forecast/reanalysis) — not physical sensor data.`
        : "No weather evidence recorded yet.",
    ),
  );
  if (wEntry) {
    const d = domains[domains.length - 1];
    d.latest_evidence_id = wEntry.id;
    d.latest_at = wEntry.observed_at;
  }

  // --- satellite
  const satelliteDomain = domainOf(
    "satellite",
    satelliteState(db, fieldId),
    satellites.n === 0 ? "NO_DATA" : "PARTIAL",
    satellites.n === 0
      ? "No satellite acquisitions found yet (provider discovery is scheduled automatically)."
      : `${satellites.n} product(s) discovered; latest acquisition ${satellites.last ?? "?"}. Metadata only — raster access requires Copernicus credentials (AUTH_REQUIRED).`,
  );
  // satellite products live in their own table — count them as evidence for the layer
  satelliteDomain.count = satellites.n;
  domains.push(satelliteDomain);

  // --- sensors (physical hardware)
  domains.push(
    domainOf(
      "sensor",
      sensor.entries,
      sensor.entries.length ? "PARTIAL" : "NO_DATA",
      sensor.entries.length
        ? `${sensor.entries.length} sensor type(s) have real observations.`
        : sensor.devices.length > 0
          ? `Registered device(s) awaiting telemetry (WAITING_FOR_DEVICE) — no observations received yet.`
          : "No physical sensor telemetry has been received (NO_DATA). Hardware gateway endpoints are ready.",
    ),
  );

  // --- soil
  const soilEntries = compactEvidence(db, fieldId, "soil", 8);
  const soilHealth = db.conn
    .query("SELECT status, last_error FROM provider_health WHERE provider = 'soilgrids'")
    .get() as { status: string; last_error: string | null } | undefined;
  const soilSummary = soilEntries.length
    ? "Soil property estimates from SoilGrids v2.0 global model (ESTIMATED, not measured)."
    : soilHealth && soilHealth.status !== "AVAILABLE" && soilHealth.status !== "NOT_CONFIGURED"
      ? `No usable soil evidence. SoilGrids provider state: ${soilHealth.status}${soilHealth.last_error ? ` — ${soilHealth.last_error.slice(0, 160)}` : ""}`
      : "No soil evidence recorded. SoilGrids refresh is scheduled automatically.";
  domains.push(domainOf("soil", soilEntries, soilEntries.length ? "PARTIAL" : "NO_DATA", soilSummary));

  // --- terrain (real DEM grid samples or honest single-point fallback)
  const terrEntries = compactEvidence(db, fieldId, "terrain", 6);
  const terrMean = latest.get("terrain:elevation_mean_m");
  const terrMin = latest.get("terrain:elevation_min_m");
  const terrMax = latest.get("terrain:elevation_max_m");
  const terrSlope = latest.get("terrain:slope_degrees");
  const terrAspect = latest.get("terrain:aspect_degrees");
  const terrCentroid = latest.get("terrain:elevation_m");
  const terrCount = latest.get("terrain:dem_sample_count");
  const terrSummary = terrMean
    ? `Real DEM grid (SRTM/ASTER samples): mean ${terrMean.value} m, min ${terrMin?.value ?? "?"} m, max ${terrMax?.value ?? "?"} m (${terrCount?.value ?? "?"} samples inside the field). ${terrSlope ? `Slope ${terrSlope.value}°, aspect ${terrAspect?.value ?? "?"}° (DERIVED from DEM samples — method in evidence).` : "Slope/aspect UNKNOWN (insufficient DEM samples to derive)."}`
    : terrCentroid
      ? `CENTROID ELEVATION only: ${terrCentroid.value} m (single point, Open-Meteo fallback). Slope/aspect UNKNOWN — no DEM grid.`
      : "No terrain evidence recorded.";
  domains.push(
    domainOf(
      "terrain",
      terrEntries,
      terrEntries.length ? "PARTIAL" : "NO_DATA",
      terrSummary,
    ),
  );

  // --- water
  const waterEntries = waterState(db, fieldId);
  const waterOsm = db.conn
    .query("SELECT status, last_error, last_success_at FROM provider_health WHERE provider = 'osm-water'")
    .get() as { status: string; last_error: string | null; last_success_at: string | null } | undefined;
  const waterWris = db.conn
    .query("SELECT status, last_error FROM provider_health WHERE provider = 'water-india'")
    .get() as { status: string; last_error: string | null } | undefined;
  const waterSummary = waterEntries.length
    ? "Surface-water context from the OpenStreetMap open spatial dataset (DERIVED — mapped water features/distance; not flow or depth). Groundwater/aquifer/irrigation layers need India-WRIS/CGWB credentials."
    : `No water evidence recorded. OSM water layer: ${waterOsm?.status ?? "not probed"}${waterOsm?.last_error ? ` (${waterOsm.last_error.slice(0, 120)})` : ""}; India-WRIS/CGWB: ${waterWris?.status ?? "NOT_CONFIGURED"}.`;
  domains.push(
    domainOf(
      "water",
      waterEntries,
      waterEntries.length ? "PARTIAL" : waterOsm?.status === "AVAILABLE" ? "NO_DATA" : waterOsm?.status && waterOsm.status !== "NOT_CONFIGURED" ? "NO_DATA" : "NOT_CONFIGURED",
      waterSummary,
    ),
  );

  // --- crop
  const crop = field?.crop_name ?? null;
  domains.push(
    domainOf(
      "crop",
      crop ? [{ crop_name: crop, source: "farmer-provided field metadata", state: "UNKNOWN" }] : [],
      crop ? "PARTIAL" : "UNKNOWN",
      crop
        ? `Crop declared as "${crop}" (farmer metadata — not independently verified). No validated growth-stage or yield model connected.`
        : "Crop is unknown (no field metadata, no validated model).",
    ),
  );

  // --- farmer
  const farmerRows = db.conn
    .query("SELECT id, text, tags, created_at, verified FROM farmer_observations WHERE field_id = ? ORDER BY created_at DESC LIMIT 5")
    .all(fieldId) as { id: string; text: string; tags: string | null; created_at: string; verified: number }[];
  domains.push(
    domainOf(
      "farmer",
      farmerRows.map((f) => ({ id: f.id, text: f.text, tags: JSON.parse(f.tags ?? "[]"), verified: !!f.verified, created_at: f.created_at })),
      farmerRows.length ? "PARTIAL" : "NO_DATA",
      farmerRows.length ? `${farmerRows.length} farmer observation(s).` : "No farmer observations yet.",
    ),
  );

  // --- simulation
  const simCount = db.conn.query("SELECT COUNT(*) as n FROM simulations WHERE field_id = ?").get(fieldId) as { n: number };
  domains.push(
    domainOf(
      "simulation",
      [],
      simCount.n > 0 ? "PARTIAL" : "NO_DATA",
      simCount.n > 0 ? `${simCount.n} simulation scenario(s) exist (SIMULATED, separate from observed reality).` : "No simulations yet.",
    ),
  );

  // freshness/uncertainty inputs
  const fresh = {
    weather: freshnessLevel(db, fieldId, "weather", 36),
    satellite: freshnessLevel(db, fieldId, "satellite", 24 * 7),
    soil: freshnessLevel(db, fieldId, "soil", 24 * 30),
    sensor: freshnessLevel(db, fieldId, "sensor", 3),
  };

  const snapshot: Record<string, unknown> = {
    field_id: fieldId,
    field: field
      ? { name: field.name, farm: field.farm_name, area_m2: field.area_m2, centroid: { lat: field.centroid_lat, lon: field.centroid_lon } }
      : null,
    domains,
    devices: sensor.devices,
    satellite: { count: satellites.n, last_acquisition: satellites.last },
    freshness: fresh,
    quality_note: "Quality is not confidence. Qualitative levels only; no statistical confidence is fabricated.",
    composed_at: nowIso(),
  };
  return { domains, snapshot };
}

export function saveWorldModelSnapshot(db: AppDb, fieldId: string, trigger: string, snapshot: Record<string, unknown>): string {
  const field = getFieldRow(db, fieldId);
  if (!field) throw new Error(`field ${fieldId} not found`);
  // domain hash for diff detection
  const hashSource = (snapshot.domains as WorldModelDomainState[])
    .map((d) => `${d.domain}:${d.count}:${d.latest_evidence_id ?? ""}:${d.state}`)
    .join("|");
  const id = newId("wm");
  db.conn
    .query("INSERT INTO world_model_states (id, user_id, farm_id, field_id, snapshot, domain_hashes, trigger, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, field.user_id, field.farm_id, fieldId, jsonStringify(snapshot), jsonStringify({ hash: sha1hex(hashSource) }), trigger, nowIso());
  return id;
}

export function latestWorldModel(db: AppDb, fieldId: string): { id: string; snapshot: Record<string, unknown>; created_at: string; trigger: string } | null {
  const row = db.conn
    .query("SELECT id, snapshot, trigger, created_at FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(fieldId) as { id: string; snapshot: string; trigger: string; created_at: string } | undefined;
  if (!row) return null;
  return { id: row.id, snapshot: jsonParse(row.snapshot, {}), created_at: row.created_at, trigger: row.trigger };
}

export function worldModelHistory(db: AppDb, fieldId: string, limit = 60): { id: string; created_at: string; trigger: string; changed_domains: string[] }[] {
  const rows = db.conn
    .query("SELECT id, snapshot, trigger, created_at FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(fieldId, String(limit)) as { id: string; snapshot: string; trigger: string; created_at: string }[];
  const out: { id: string; created_at: string; trigger: string; changed_domains: string[] }[] = [];
  let prevDigest: string[] | null = null;
  for (const r of rows.reverse()) {
    const snap = jsonParse(r.snapshot, {});
    const domains = (snap as { domains?: { domain: string; count: number; latest_evidence_id: string | null }[] }).domains ?? [];
    const digest = domains
      .map((d) => `${d.domain}:${d.count}:${d.latest_evidence_id ?? ""}`)
      .sort();
    const changedDomains =
      prevDigest === null
        ? domains.map((d) => d.domain)
        : (() => {
            const prev = prevDigest;
            return digest.filter((d) => !prev.includes(d)).map((d) => d.split(":")[0]);
          })();
    prevDigest = digest;
    out.push({ id: r.id, created_at: r.created_at, trigger: r.trigger, changed_domains: changedDomains });
  }
  return out;
}

export function worldModelDiff(db: AppDb, _fieldId: string, beforeId: string, afterId: string): { domain: string; before_state: string; after_state: string; changed: boolean }[] {
  const get = (id: string) => {
    const row = db.conn.query("SELECT snapshot FROM world_model_states WHERE id = ?").get(id) as { snapshot: string } | undefined;
    if (!row) return null;
    const snap = jsonParse(row.snapshot, {}) as { domains?: WorldModelDomainState[] };
    return snap.domains ?? [];
  };
  const a = get(beforeId) ?? [];
  const b = get(afterId) ?? [];
  const map = (list: WorldModelDomainState[]) => new Map(list.map((d) => [d.domain, d]));
  const mA = map(a);
  const mB = map(b);
  return [...new Set([...mA.keys(), ...mB.keys()])].map((domain) => ({
    domain,
    before_state: mA.get(domain)?.state ?? "ABSENT",
    after_state: mB.get(domain)?.state ?? "ABSENT",
    changed: (mA.get(domain)?.state ?? "ABSENT") !== (mB.get(domain)?.state ?? "ABSENT"),
  }));
}

export function asTruthLabel(): TruthState[] {
  return ["OBSERVED", "DERIVED", "ESTIMATED", "HISTORICAL", "PREDICTED", "SIMULATED", "UNKNOWN"];
}
