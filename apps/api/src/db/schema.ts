/**
 * AGRIFUR2 database schema.
 *
 * Development/runtime database is a persistent SQLite file (bun:sqlite).
 * Geometry is stored as GeoJSON TEXT plus derived scalar columns
 * (centroid lat/lon, bbox, area) so spatial queries stay simple and honest.
 *
 * The table set mirrors the production PostgreSQL/PostGIS target (see
 * docker-compose.yml and docs/DATA_MODEL.md); this adapter is the verified
 * implementation. Postgres/PostGIS SQL is provided in db/postgres.sql but is
 * NOT executed in this environment (no Postgres server available here).
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'farmer' CHECK (role IN ('admin','farmer')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_farms_user ON farms(user_id);

CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  crop_name TEXT,
  geometry TEXT NOT NULL,            -- GeoJSON Polygon/MultiPolygon
  centroid_lat REAL NOT NULL,
  centroid_lon REAL NOT NULL,
  bbox TEXT NOT NULL,                -- JSON {min_lon,min_lat,max_lon,max_lat}
  area_m2 REAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fields_farm ON fields(farm_id);
CREATE INDEX IF NOT EXISTS idx_fields_user ON fields(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  field_id TEXT REFERENCES fields(id) ON DELETE SET NULL,
  external_id TEXT UNIQUE,           -- stable firmware/MQTT device id, e.g. AGRIFUR-ESP32-001
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'sensor_node' CHECK (kind IN ('sensor_node','voice_device','gateway')),
  firmware_version TEXT,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','online','offline','error')),
  last_seen_at TEXT,
  metadata TEXT,                     -- JSON: deployment info, calibration_version, channels, location {lat,lon}
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_field ON devices(field_id);
-- NOTE: idx_devices_external is intentionally NOT created here. It references
-- external_id, which only exists on databases created by a recent schema.
-- Older databases get the column added by migrate()'s ensureColumn() first,
-- and migrate() creates the index right after — creating it inside SCHEMA_SQL
-- would crash the boot of pre-MQTT databases (no such column).

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sensor_type TEXT NOT NULL,         -- e.g. soil_moisture, air_temperature, humidity
  value REAL NOT NULL,
  unit TEXT,
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  ingestion_id TEXT UNIQUE,          -- dedupe key supplied by device
  quality TEXT,
  calibration_version TEXT,
  firmware_version TEXT,
  provenance TEXT,                   -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_field_time ON observations(field_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(sensor_type, observed_at);

-- Canonical evidence rows. Every domain is explicitly classified here.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('sensor','satellite','weather','water','soil','terrain','crop','farmer','history','simulation','environment')),
  source TEXT NOT NULL,
  source_type TEXT NOT NULL,
  sub_type TEXT NOT NULL,
  description TEXT,
  measurement TEXT,
  value REAL,
  unit TEXT,
  state TEXT NOT NULL CHECK (state IN ('OBSERVED','DERIVED','ESTIMATED','HISTORICAL','PREDICTED','SIMULATED','UNKNOWN')),
  quality TEXT CHECK (quality IN ('high','medium','low') OR quality IS NULL),
  quality_reason TEXT,
  observed_at TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  geometry TEXT,
  provenance TEXT,                   -- JSON Provenance
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_field ON evidence(field_id);
CREATE INDEX IF NOT EXISTS idx_evidence_field_domain ON evidence(field_id, domain, observed_at);
CREATE INDEX IF NOT EXISTS idx_evidence_field_type ON evidence(field_id, sub_type, observed_at);

CREATE TABLE IF NOT EXISTS evidence_relationships (
  id TEXT PRIMARY KEY,
  field_id TEXT NOT NULL,
  evidence_a TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  evidence_b TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('DERIVED_FROM','SUPPORTS','CORROBORATES','CONTRADICTS','TEMPORALLY_RELATED','SPATIALLY_OVERLAPS')),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rel_field ON evidence_relationships(field_id);

CREATE TABLE IF NOT EXISTS satellite_products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  satellite TEXT NOT NULL,
  product_id TEXT NOT NULL,           -- provider item id (scene is shared across fields; uniqueness is per field_id+product_id)
  collection TEXT,
  acquired_at TEXT NOT NULL,
  cloud_cover REAL,
  resolution_m REAL,
  processing_level TEXT,
  geometry TEXT,
  assets TEXT,                       -- JSON list {href,type,title,credential_gated}
  platform TEXT,
  orbit_relative INTEGER,
  polarization TEXT,
  product_type TEXT,
  preview_available INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'OBSERVED' CHECK (state IN ('OBSERVED','AUTH_REQUIRED','NO_DATA')),
  status TEXT NOT NULL DEFAULT 'discovered' CHECK (status IN ('discovered','processing','processed','failed','auth_required')),
  source_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sat_field_time ON satellite_products(field_id, acquired_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sat_field_product ON satellite_products(field_id, product_id);

CREATE TABLE IF NOT EXISTS farmer_observations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  text TEXT NOT NULL,
  tags TEXT,                          -- JSON array e.g. ["reported_no_rain"]
  state TEXT NOT NULL DEFAULT 'OBSERVED',
  verified INTEGER NOT NULL DEFAULT 0,
  verified_by TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_farmer_field ON farmer_observations(field_id, created_at);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'recommended' CHECK (status IN ('recommended','taken','verified','dismissed')),
  recommendation_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  action_id TEXT,
  investigation_id TEXT,
  outcome TEXT,
  state TEXT NOT NULL DEFAULT 'OBSERVED',
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS anomalies (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- sensor_spike, heavy_rainfall, vegetation_change, moisture_drop, ...
  severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high')),
  level TEXT NOT NULL,                -- severity label
  description TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,         -- JSON array of evidence ids
  trigger TEXT NOT NULL,              -- how it was detected
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','dismissed')),
  detected_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_anomalies_field ON anomalies(field_id, detected_at);

CREATE TABLE IF NOT EXISTS risks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  risk_type TEXT NOT NULL,            -- heat_stress, water_stress, flood, waterlogging, sensor_reliability, disease_pest, nutrient
  level TEXT NOT NULL CHECK (level IN ('LOW','MEDIUM','HIGH','UNKNOWN')),
  reason TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','mitigating','resolved','dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_risks_field ON risks(field_id, created_at);

CREATE TABLE IF NOT EXISTS uncertainties (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- missing_data, stale_evidence, conflicting_sources, model_limitations, provider_gap
  domain TEXT,
  level TEXT NOT NULL CHECK (level IN ('LOW','MEDIUM','HIGH','UNKNOWN')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unc_field ON uncertainties(field_id, created_at);

CREATE TABLE IF NOT EXISTS contradictions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  evidence_a TEXT NOT NULL,
  evidence_b TEXT NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'CONTRADICTS',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','dismissed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contrad_field ON contradictions(field_id, created_at);

CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','collecting_evidence','hypothesis_testing','resolved','escalated','closed')),
  trigger TEXT,
  conclusion TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inv_field ON investigations(field_id, created_at);

CREATE TABLE IF NOT EXISTS investigation_evidence (
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'context',
  created_at TEXT NOT NULL,
  PRIMARY KEY (investigation_id, evidence_id)
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','testing','supported','rejected','inconclusive')),
  tested_with TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hyp_inv ON hypotheses(investigation_id);

CREATE TABLE IF NOT EXISTS next_observations (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  rank TEXT NOT NULL CHECK (rank IN ('HIGH','MEDIUM','LOW')),
  observation TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','requested','done','dismissed')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_next_inv ON next_observations(investigation_id);

CREATE TABLE IF NOT EXISTS world_model_states (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,             -- JSON WorldModelRecord.snapshot_json
  domain_hashes TEXT NOT NULL,        -- JSON {domain: sha1-of-latest-ids}
  trigger TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wm_field ON world_model_states(field_id, created_at);

CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  name TEXT NOT NULL,
  scenario TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT NOT NULL,
  inputs TEXT NOT NULL,
  assumptions TEXT NOT NULL,
  limitations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','running','completed','failed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  output TEXT NOT NULL,               -- JSON labelled SIMULATED
  ran_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  field_id TEXT,
  title TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  meta TEXT,                          -- JSON AssistantAnswer
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_session ON assistant_messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS farm_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  farm_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- world_model_change, action_taken, investigation_resolved, observation, verification
  ref_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  happened_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_field ON farm_memory(field_id, happened_at);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  field_id TEXT,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','RETRYING','BLOCKED','NO_DATA','AUTH_REQUIRED')),
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_field ON jobs(field_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  farm_id TEXT,
  field_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,                       -- JSON
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_field_time ON events(field_id, created_at);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_check_at TEXT,
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT,
  latency_ms REAL,
  auth_state TEXT NOT NULL DEFAULT 'unknown',
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
`;
