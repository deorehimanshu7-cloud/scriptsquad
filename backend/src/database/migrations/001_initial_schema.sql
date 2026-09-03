-- ============================================================================
-- AGRIFUR2 Database Schema — PostgreSQL + PostGIS (CANONICAL / PRODUCTION)
-- ============================================================================
-- All geometry is stored as GEOMETRY(..., 4326). Every field metric is computed
-- by PostGIS (never by the client): geodesic area/perimeter via ST_Transform to
-- a local equal-area UTM projection, centroid, envelope, validity.
--
-- Migration runner: backend/src/database/migrate.ts (npm run db:migrate)

CREATE EXTENSION IF NOT EXISTS postgis;

-- ============================================================================
-- Helpers
-- ============================================================================

-- Pick the local equal-area UTM SRID for a geometry (zone by centroid longitude).
CREATE OR REPLACE FUNCTION agrifur2_utm_srid(g GEOMETRY) RETURNS INTEGER
LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN ST_Y(ST_Centroid(g)) >= 0 THEN 32600
    ELSE 32700
  END + floor((ST_X(ST_Centroid(g)) + 180) / 6)::integer + 1
$$;

-- BEFORE INSERT/UPDATE trigger: compute metrics from canonical geometry.
CREATE OR REPLACE FUNCTION agrifur2_fields_metrics() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  utm INTEGER;
  local_geom GEOMETRY;
BEGIN
  utm := agrifur2_utm_srid(NEW.geometry);
  local_geom := ST_Transform(NEW.geometry, utm);
  NEW.area_m2 := ST_Area(local_geom);
  NEW.perimeter_m := ST_Perimeter(local_geom);
  NEW.area_hectares := ST_Area(local_geom) / 10000.0;
  NEW.centroid := ST_SetSRID(ST_Centroid(NEW.geometry), 4326);
  NEW.bbox := ST_SetSRID(ST_Envelope(NEW.geometry), 4326);
  NEW.srid := 4326;
  NEW.geometry_valid := ST_IsValid(NEW.geometry);
  RETURN NEW;
END;
$$;

-- ============================================================================
-- USERS & AUTH
-- ============================================================================
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255),
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ============================================================================
-- FARMS & FIELDS
-- ============================================================================
CREATE TABLE farms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  location GEOMETRY(Point, 4326),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_farms_user_id ON farms(user_id);
CREATE INDEX idx_farms_location ON farms USING GIST(location);

CREATE TABLE fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES farms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  geometry GEOMETRY(Polygon, 4326) NOT NULL,
  geometry_valid BOOLEAN,
  area_m2 DOUBLE PRECISION,
  area_hectares DOUBLE PRECISION,
  perimeter_m DOUBLE PRECISION,
  centroid GEOMETRY(Point, 4326),
  bbox GEOMETRY(Polygon, 4326),
  srid INTEGER NOT NULL DEFAULT 4326,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fields_farm_id ON fields(farm_id);
CREATE INDEX idx_fields_user_id ON fields(user_id);
CREATE INDEX idx_fields_geometry ON fields USING GIST(geometry);
CREATE INDEX idx_fields_centroid ON fields USING GIST(centroid);
CREATE TRIGGER trg_fields_metrics
  BEFORE INSERT OR UPDATE OF geometry ON fields
  FOR EACH ROW EXECUTE FUNCTION agrifur2_fields_metrics();

CREATE TABLE field_geometry_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  geometry GEOMETRY(Polygon, 4326) NOT NULL,
  version INTEGER NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fgv_field_id ON field_geometry_versions(field_id);

-- ============================================================================
-- CROPS
-- ============================================================================
CREATE TABLE crop_cycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  crop_type VARCHAR(100) NOT NULL,
  variety VARCHAR(100),
  season VARCHAR(50),
  sowing_date DATE,
  expected_harvest_date DATE,
  actual_harvest_date DATE,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_crop_cycles_field_id ON crop_cycles(field_id);

CREATE TABLE crop_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  crop_cycle_id UUID NOT NULL REFERENCES crop_cycles(id) ON DELETE CASCADE,
  growth_stage VARCHAR(50),
  health_index DOUBLE PRECISION,
  observations JSONB NOT NULL DEFAULT '{}',
  state VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_crop_states_cycle_id ON crop_states(crop_cycle_id);

-- ============================================================================
-- DEVICES / SENSORS / OBSERVATIONS
-- ============================================================================
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  farm_id UUID REFERENCES farms(id) ON DELETE SET NULL,
  field_id UUID REFERENCES fields(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  serial_number VARCHAR(255),
  firmware_version VARCHAR(50),
  hardware_version VARCHAR(50),
  status VARCHAR(30) NOT NULL DEFAULT 'inactive',
  location GEOMETRY(Point, 4326),
  api_key VARCHAR(255),
  last_seen_at TIMESTAMPTZ,
  battery DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_devices_user_id ON devices(user_id);
CREATE INDEX idx_devices_field_id ON devices(field_id);
CREATE INDEX idx_devices_location ON devices USING GIST(location);

CREATE TABLE device_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  deployment_date DATE NOT NULL,
  removal_date DATE,
  location GEOMETRY(Point, 4326),
  depth_meters DOUBLE PRECISION,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_deployments_field_id ON device_deployments(field_id);

CREATE TABLE sensors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  sensor_type VARCHAR(50) NOT NULL,
  unit VARCHAR(20),
  min_value DOUBLE PRECISION,
  max_value DOUBLE PRECISION,
  calibration_version INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sensors_device_id ON sensors(device_id);

CREATE TABLE sensor_calibrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sensor_id UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  calibration_data JSONB NOT NULL DEFAULT '{}',
  method VARCHAR(255),
  valid_until TIMESTAMPTZ,
  calibrated_by VARCHAR(255),
  calibrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_calibrations_sensor_id ON sensor_calibrations(sensor_id);

CREATE TABLE observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  farm_id UUID NOT NULL REFERENCES farms(id),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id),
  deployment_id UUID REFERENCES device_deployments(id),
  sensor_id UUID REFERENCES sensors(id),
  sensor_type VARCHAR(50),
  geometry GEOMETRY(Point, 4326),
  depth_meters DOUBLE PRECISION,
  "timestamp" TIMESTAMPTZ NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit VARCHAR(20),
  quality VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
  calibration_version INTEGER,
  firmware_version VARCHAR(50),
  provenance JSONB NOT NULL DEFAULT '{}',
  ingestion_metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_observations_field_id ON observations(field_id);
CREATE INDEX idx_observations_sensor_id ON observations(sensor_id);
CREATE INDEX idx_observations_timestamp ON observations("timestamp" DESC);
CREATE INDEX idx_observations_device_id ON observations(device_id);

-- Raw telemetry (preserved verbatim before validation; PostgreSQL persists
-- canonical observations — MQTT is transport only)
CREATE TABLE telemetry_raw (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id VARCHAR(255),
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  field_id UUID REFERENCES fields(id) ON DELETE SET NULL,
  topic VARCHAR(500),
  payload JSONB NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state VARCHAR(30) NOT NULL DEFAULT 'RECEIVED',
  outcome JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_telemetry_raw_device_message ON telemetry_raw(device_id, message_id);
CREATE INDEX idx_telemetry_raw_received ON telemetry_raw(received_at DESC);

-- Device heartbeats (connectivity evidence; device state derived from activity)
CREATE TABLE device_heartbeats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  battery DOUBLE PRECISION,
  signal_strength DOUBLE PRECISION,
  uptime_s DOUBLE PRECISION,
  firmware_version VARCHAR(50),
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_heartbeats_device ON device_heartbeats(device_id, recorded_at DESC);

-- Device lifecycle/connectivity events (connect, disconnect, error, sync…)
CREATE TABLE device_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_device_events_device ON device_events(device_id, occurred_at DESC);

-- Downlink commands (authorized, whitelisted, audited; never raw actuator control)
CREATE TABLE commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  field_id UUID REFERENCES fields(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id),
  command VARCHAR(80) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(30) NOT NULL DEFAULT 'QUEUED',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  acked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  ack_message_id VARCHAR(255),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_commands_device ON commands(device_id, status);

-- ============================================================================
-- PROVIDERS
-- ============================================================================
CREATE TABLE providers (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
  config JSONB NOT NULL DEFAULT '{}',
  last_check TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE provider_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id VARCHAR(100) NOT NULL REFERENCES providers(id),
  request_type VARCHAR(100) NOT NULL,
  params JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(30) NOT NULL,
  response_data JSONB,
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_provider_requests_provider_id ON provider_requests(provider_id);
CREATE INDEX idx_provider_requests_created_at ON provider_requests(created_at DESC);

CREATE TABLE provider_health (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id VARCHAR(100) NOT NULL REFERENCES providers(id),
  status VARCHAR(30) NOT NULL,
  latency_ms INTEGER,
  error_rate DOUBLE PRECISION,
  success_rate DOUBLE PRECISION,
  last_error TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_provider_health_provider_id ON provider_health(provider_id);

-- ============================================================================
-- SATELLITE
-- ============================================================================
CREATE TABLE satellite_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id VARCHAR(100) NOT NULL,
  collection VARCHAR(100) NOT NULL,
  product_id VARCHAR(255) NOT NULL,
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE,
  geometry GEOMETRY(Polygon, 4326),
  cloud_cover DOUBLE PRECISION,
  observation_date TIMESTAMPTZ NOT NULL,
  assets JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_satellite_field_id ON satellite_products(field_id);
CREATE INDEX idx_satellite_date ON satellite_products(observation_date DESC);
CREATE INDEX idx_satellite_geometry ON satellite_products USING GIST(geometry);

-- ============================================================================
-- EVIDENCE (core)
-- ============================================================================
CREATE TABLE evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  farm_id UUID NOT NULL REFERENCES farms(id),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  source VARCHAR(40) NOT NULL CHECK (source IN (
    'PHYSICAL_HARDWARE','EARTH_OBSERVATION','WATER','ENVIRONMENT','AGRICULTURE',
    'HISTORY','FARMER_INPUT','SIMULATION_VIRTUAL')),
  provider VARCHAR(100),
  geometry GEOMETRY(Geometry, 4326),
  observation_time TIMESTAMPTZ NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  measurement JSONB NOT NULL,
  unit VARCHAR(30),
  state VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN' CHECK (state IN (
    'OBSERVED','DERIVED','ESTIMATED','HISTORICAL','REANALYSIS','MODEL_DERIVED',
    'PREDICTED','SIMULATED','MODELLED','UNKNOWN')),
  quality JSONB,
  processing JSONB NOT NULL DEFAULT '{"processed":false,"steps":[]}',
  provenance JSONB NOT NULL DEFAULT '{}',
  uncertainty JSONB,
  depth_meters DOUBLE PRECISION,
  device_id UUID,
  sensor_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_evidence_field_id ON evidence(field_id);
CREATE INDEX idx_evidence_field_time ON evidence(field_id, observation_time DESC);
CREATE INDEX idx_evidence_source ON evidence(source);
CREATE INDEX idx_evidence_geometry ON evidence USING GIST(geometry);

CREATE TABLE evidence_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  target_evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  relationship VARCHAR(30) NOT NULL CHECK (relationship IN (
    'DERIVED_FROM','SUPPORTS','CONTRADICTS','CORROBORATES',
    'TEMPORALLY_RELATED','SPATIALLY_OVERLAPS')),
  rationale TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_er_source ON evidence_relationships(source_evidence_id);
CREATE INDEX idx_er_target ON evidence_relationships(target_evidence_id);

-- ============================================================================
-- ENVIRONMENTAL (weather / water / soil / terrain)
-- ============================================================================
CREATE TABLE weather_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  provider VARCHAR(100),
  "timestamp" TIMESTAMPTZ NOT NULL,
  kind VARCHAR(30) NOT NULL,            -- current | forecast | history | anomaly
  semantics VARCHAR(30) NOT NULL,       -- OBSERVED | MODEL_DERIVED | PREDICTED | REANALYSIS
  data JSONB NOT NULL,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_weather_field_id ON weather_observations(field_id);
CREATE INDEX idx_weather_field_time ON weather_observations(field_id, "timestamp" DESC);

CREATE TABLE water_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  domain VARCHAR(30) NOT NULL,
  state VARCHAR(30) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  provider VARCHAR(100),
  observed_at TIMESTAMPTZ,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_water_field_id ON water_observations(field_id);

CREATE TABLE soil_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  property VARCHAR(60) NOT NULL,
  value DOUBLE PRECISION,
  unit VARCHAR(30),
  state VARCHAR(30) NOT NULL,
  source VARCHAR(200),
  "timestamp" TIMESTAMPTZ,
  quality JSONB,
  uncertainty JSONB,
  provenance JSONB NOT NULL DEFAULT '{}',
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_soil_field_id ON soil_observations(field_id);

CREATE TABLE terrain_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  kind VARCHAR(30) NOT NULL,            -- elevation | slope | aspect | dem
  state VARCHAR(30) NOT NULL,
  data JSONB NOT NULL DEFAULT '{}',
  provider VARCHAR(100),
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_terrain_field_id ON terrain_products(field_id);

-- ============================================================================
-- WORLD MODEL
-- ============================================================================
CREATE TABLE world_model_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  world_model JSONB NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wm_field_id ON world_model_states(field_id);
CREATE INDEX idx_wm_field_time ON world_model_states(field_id, created_at DESC);

CREATE TABLE world_model_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  geometry GEOMETRY(Geometry, 4326),
  properties JSONB NOT NULL DEFAULT '{}',
  state VARCHAR(30) NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_wmz_field_id ON world_model_zones(field_id);
CREATE INDEX idx_wmz_geometry ON world_model_zones USING GIST(geometry);

-- ============================================================================
-- INTELLIGENCE
-- ============================================================================
CREATE TABLE anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  type VARCHAR(60) NOT NULL,
  subtype VARCHAR(60),
  "timestamp" TIMESTAMPTZ NOT NULL,
  method VARCHAR(80) NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  state VARCHAR(30) NOT NULL DEFAULT 'DETECTED',
  severity VARCHAR(10),
  quality JSONB,
  geometry GEOMETRY(Geometry, 4326),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_anomalies_field_id ON anomalies(field_id);
CREATE INDEX idx_anomalies_field_time ON anomalies(field_id, "timestamp" DESC);

CREATE TABLE risks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  type VARCHAR(60) NOT NULL,
  severity VARCHAR(10) NOT NULL,
  time_horizon VARCHAR(30),
  affected_geometry GEOMETRY(Geometry, 4326),
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  description TEXT,
  trigger_reason TEXT,
  uncertainty VARCHAR(30) NOT NULL DEFAULT 'NOT_ASSESSED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_risks_field_id ON risks(field_id);
CREATE INDEX idx_risks_field_status ON risks(field_id, status);

CREATE TABLE uncertainties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  assessment JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_uncertainties_field_id ON uncertainties(field_id);

CREATE TABLE contradictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  type VARCHAR(60) NOT NULL,
  description TEXT NOT NULL,
  evidence_a_id UUID,
  evidence_b_id UUID,
  source_a VARCHAR(40),
  source_b VARCHAR(40),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  state VARCHAR(30) NOT NULL DEFAULT 'DETECTED',
  severity VARCHAR(10) NOT NULL DEFAULT 'LOW',
  hypothesis TEXT
);
CREATE INDEX idx_contradictions_field_id ON contradictions(field_id);
CREATE INDEX idx_contradictions_state ON contradictions(field_id, state);

-- ============================================================================
-- INVESTIGATIONS / HYPOTHESES / NEXT BEST OBSERVATIONS
-- ============================================================================
CREATE TABLE investigations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(255) NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  trigger_type VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
  trigger_data JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(30) NOT NULL DEFAULT 'OPEN',
  hypotheses JSONB NOT NULL DEFAULT '[]',
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  supporting_ids JSONB NOT NULL DEFAULT '[]',
  conflicting_ids JSONB NOT NULL DEFAULT '[]',
  missing JSONB NOT NULL DEFAULT '[]',
  next_observations JSONB NOT NULL DEFAULT '[]',
  conclusion TEXT,
  action_recommendation TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_investigations_field_id ON investigations(field_id);
CREATE INDEX idx_investigations_status ON investigations(field_id, status);

CREATE TABLE hypotheses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  supporting_evidence JSONB NOT NULL DEFAULT '[]',
  conflicting_evidence JSONB NOT NULL DEFAULT '[]',
  missing_evidence JSONB NOT NULL DEFAULT '[]',
  next_observation TEXT,
  probability DOUBLE PRECISION,          -- only from a calibrated model; else NULL
  status VARCHAR(20) NOT NULL DEFAULT 'PROPOSED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_hypotheses_inv_id ON hypotheses(investigation_id);

CREATE TABLE next_best_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id UUID NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
  candidate TEXT NOT NULL,
  rationale TEXT,
  priority VARCHAR(10) NOT NULL DEFAULT 'MEDIUM',
  cost TEXT,
  delay TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_nbo_inv_id ON next_best_observations(investigation_id);

-- ============================================================================
-- ACTIONS / VERIFICATION / FARM MEMORY
-- ============================================================================
CREATE TABLE recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  investigation_id UUID REFERENCES investigations(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  expected_outcome JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_recommendations_field_id ON recommendations(field_id);

CREATE TABLE actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  recommendation_id UUID REFERENCES recommendations(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'RECOMMENDED',
  expected_outcome JSONB NOT NULL DEFAULT '{}',
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_actions_field_id ON actions(field_id);

CREATE TABLE verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  entity_type VARCHAR(40) NOT NULL,
  entity_id UUID NOT NULL,
  expected_outcome JSONB NOT NULL DEFAULT '{}',
  actual_outcome JSONB NOT NULL DEFAULT '{}',
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  result VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_verifications_field_id ON verifications(field_id);

CREATE TABLE farm_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  evidence_ids JSONB NOT NULL DEFAULT '[]',
  reasoning TEXT,
  action TEXT,
  expected_outcome JSONB NOT NULL DEFAULT '{}',
  actual_outcome JSONB NOT NULL DEFAULT '{}',
  verification_result TEXT,
  learned_rule TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_farm_memory_field_id ON farm_memory(field_id);

-- ============================================================================
-- FARMER OBSERVATIONS (UNVERIFIED until corroborated)
-- ============================================================================
CREATE TABLE farmer_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  farm_id UUID NOT NULL REFERENCES farms(id),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  location GEOMETRY(Point, 4326),
  verification VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED',
  corroborating_evidence_ids JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_fo_field_id ON farmer_observations(field_id);

-- ============================================================================
-- ASSISTANT
-- ============================================================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE,
  language VARCHAR(10) NOT NULL DEFAULT 'en',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_conversations_field_id ON conversations(field_id);
CREATE INDEX idx_conversations_user_id ON conversations(user_id);

CREATE TABLE conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  tool_calls JSONB NOT NULL DEFAULT '[]',
  evidence_refs JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation_id ON conversation_messages(conversation_id);

-- ============================================================================
-- SIMULATION (SIMULATED world — isolated from live world model)
-- ============================================================================
CREATE TABLE simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_id UUID NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(255),
  scenario JSONB NOT NULL DEFAULT '{}',
  assumptions JSONB NOT NULL DEFAULT '[]',
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  result JSONB NOT NULL DEFAULT '{}',
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_simulations_field_id ON simulations(field_id);

-- ============================================================================
-- SYSTEM: events / jobs / notifications / audit
-- ============================================================================
CREATE TABLE events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(60) NOT NULL,
  field_id UUID,
  user_id UUID,
  data JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_field_id ON events(field_id);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_created_at ON events(created_at DESC);

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  field_id UUID,
  params JSONB NOT NULL DEFAULT '{}',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  type VARCHAR(40) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notifications_user_id ON notifications(user_id);

CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60),
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}',
  request_id VARCHAR(80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);

-- ============================================================================
-- updated_at triggers
-- ============================================================================
CREATE OR REPLACE FUNCTION agrifur2_touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','farms','fields','crop_cycles','devices','providers','investigations','recommendations','actions','simulations','conversations','jobs']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION agrifur2_touch_updated_at()', t, t);
  END LOOP;
END $$;
