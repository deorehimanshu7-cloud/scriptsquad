/**
 * AGRIFUR2 shared domain contracts.
 *
 * Single source of truth for the states, enums and DTOs used by the API and
 * consumed by the web app. The API is the authority; the web client never
 * invents values that the API did not produce.
 */

// ---------------------------------------------------------------------------
// Truth states — every piece of data must carry one of these.
// ---------------------------------------------------------------------------
export const TRUTH_STATES = [
  "OBSERVED",
  "DERIVED",
  "ESTIMATED",
  "HISTORICAL",
  "PREDICTED",
  "SIMULATED",
  "UNKNOWN",
] as const;
export type TruthState = (typeof TRUTH_STATES)[number];

/** Visual/provenance labels used for modelled geometry (procedural twins). */
export const MODELLING_LABELS = ["MODELLED", "SIMULATED"] as const;
export type ModellingLabel = (typeof MODELLING_LABELS)[number];

// ---------------------------------------------------------------------------
// Provider states
// ---------------------------------------------------------------------------
export const PROVIDER_STATES = [
  "AVAILABLE",
  "NO_DATA",
  "AUTH_REQUIRED",
  "NOT_CONFIGURED",
  "RATE_LIMITED",
  "TIMEOUT",
  "PROVIDER_ERROR",
  "UNAVAILABLE",
  "DATA_QUALITY_FAILURE",
] as const;
export type ProviderState = (typeof PROVIDER_STATES)[number];

// ---------------------------------------------------------------------------
// Evidence domains (8-layer stack + supporting)
// ---------------------------------------------------------------------------
export const DOMAINS = [
  "sensor", // layer 1 — physical hardware
  "satellite", // layer 2 — earth observation
  "water", // layer 3
  "environment", // layer 4 (soil + terrain split below for classification safety)
  "soil",
  "terrain",
  "crop", // layer 5
  "history", // layer 6 (system-managed)
  "farmer", // layer 7
  "simulation", // layer 8
  "weather",
] as const;
export type Domain = (typeof DOMAINS)[number];

export const DOMAIN_LABELS: Record<Domain, string> = {
  sensor: "Physical sensors",
  satellite: "Earth observation",
  water: "Water",
  environment: "Environment",
  soil: "Soil",
  terrain: "Terrain",
  crop: "Crop",
  history: "History",
  farmer: "Farmer input",
  simulation: "Simulation / virtual",
  weather: "Weather",
};

/** The evidence source systems the provider orchestrator talks to. */
export const PROVIDERS = [
  "sensors", // local ingestion (hardware gateway)
  "mqtt-broker", // LAN MQTT broker (Mosquitto) for physical telemetry
  "openmeteo", // weather + elevation (keyless)
  "opentopodata", // real DEM rasters — SRTM 90m / ASTER 30m (keyless)
  "copernicus", // Sentinel metadata (STAC, keyless discovery) — Landsat needs a separate credential-gated adapter
  "soilgrids", // soil properties (keyless REST)
  "water-india", // India-WRIS / CGWB style sources (credential-gated)
  "osm-water", // OpenStreetMap water features (keyless open spatial dataset, ODbL)
  "bhoonidhi", // NRSC/ISRO (credential-gated)
  "llm", // optional model provider
] as const;
export type ProviderId = (typeof PROVIDERS)[number];

// ---------------------------------------------------------------------------
// Evidence relationships
// ---------------------------------------------------------------------------
export const EVIDENCE_RELATIONSHIPS = [
  "DERIVED_FROM",
  "SUPPORTS",
  "CORROBORATES",
  "CONTRADICTS",
  "TEMPORALLY_RELATED",
  "SPATIALLY_OVERLAPS",
] as const;
export type EvidenceRelationship = (typeof EVIDENCE_RELATIONSHIPS)[number];

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------
export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const SEVERITIES = ["info", "low", "medium", "high"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INVESTIGATION_STATUSES = [
  "open",
  "collecting_evidence",
  "hypothesis_testing",
  "resolved",
  "escalated",
  "closed",
] as const;
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number];

export const HYPOTHESIS_STATUSES = ["proposed", "testing", "supported", "rejected", "inconclusive"] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

// ---------------------------------------------------------------------------
// Continuous monitoring
// ---------------------------------------------------------------------------
export const JOB_TYPES = [
  "FIELD_REFRESH",
  "WEATHER_REFRESH",
  "SATELLITE_DISCOVERY",
  "SATELLITE_PROCESSING",
  "SENSOR_INGESTION",
  "EVIDENCE_VALIDATION",
  "WORLD_MODEL_UPDATE",
  "INTELLIGENCE_UPDATE",
  "INVESTIGATION_UPDATE",
  "VERIFICATION_CHECK",
  "SOIL_REFRESH",
  "WATER_REFRESH",
  "TERRAIN_REFRESH",
  "CROP_REFRESH",
  "PROVIDER_HEALTH",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "RETRYING",
  "BLOCKED",
  "NO_DATA",
  "AUTH_REQUIRED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ---------------------------------------------------------------------------
// Realtime events
// ---------------------------------------------------------------------------
export const EVENT_TYPES = [
  "FIELD_UPDATED",
  "EVIDENCE_ADDED",
  "SATELLITE_UPDATED",
  "WEATHER_UPDATED",
  "SENSOR_TELEMETRY",
  "DEVICE_HEARTBEAT",
  "ANOMALY_CREATED",
  "RISK_UPDATED",
  "UNCERTAINTY_UPDATED",
  "INVESTIGATION_UPDATED",
  "WORLD_MODEL_UPDATED",
  "JOB_UPDATED",
  "PROVIDER_STATUS_CHANGED",
  "FARMER_OBSERVATION_ADDED",
  "ACTION_CREATED",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Core records
// ---------------------------------------------------------------------------
export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: "admin" | "farmer";
  created_at: string;
}

export interface FarmRecord {
  id: string;
  user_id: string;
  name: string;
  location_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface FieldGeometry {
  type: "Polygon" | "MultiPolygon";
  coordinates: number[][][][] | number[][][];
  centroid?: { lat: number; lon: number };
}

export interface FieldRecord {
  id: string;
  farm_id: string;
  user_id: string;
  name: string;
  crop_name: string | null;
  geometry: FieldGeometry;
  centroid_lat: number;
  centroid_lon: number;
  bbox: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
  area_m2: number | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceRecord {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  domain: Domain;
  source: string;
  source_type: string;
  sub_type: string; // variable / product kind, e.g. "temperature_2m", "ndvi", "phh2o"
  description: string | null;
  measurement: string | null;
  value: number | null;
  unit: string | null;
  state: TruthState;
  quality: "high" | "medium" | "low" | null;
  quality_reason: string | null;
  observed_at: string;
  retrieved_at: string;
  geometry: unknown | null;
  provenance: Provenance;
  created_at: string;
}

export interface Provenance {
  provider: string;
  model?: string;
  model_version?: string;
  processing?: string;
  access_url?: string;
  credential_gated?: boolean;
  note?: string;
}

export interface ProviderHealthRecord {
  provider: ProviderId;
  status: ProviderState;
  last_check_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  latency_ms: number | null;
  auth_state: "none" | "configured" | "required" | "unknown";
  note: string | null;
}

export interface JobRecord {
  id: string;
  field_id: string | null;
  type: JobType;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  retry_count: number;
  detail: unknown;
  created_at: string;
}

export interface WorldModelDomainState {
  domain: Domain;
  state: TruthState | "NO_DATA" | "AUTH_REQUIRED" | "NOT_CONFIGURED" | "PARTIAL";
  latest_evidence_id: string | null;
  latest_at: string | null;
  count: number;
  summary: string;
  entries: unknown[];
}

export interface WorldModelRecord {
  id: string;
  field_id: string;
  domains: WorldModelDomainState[];
  snapshot_json: Record<string, unknown>;
  trigger: string;
  created_at: string;
}

export interface AssistantMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  meta: unknown;
  created_at: string;
}

/** Response envelope used by grounded assistant (LLM or local fallback). */
export interface AssistantAnswer {
  answer: string;
  mode: "LLM" | "LOCAL_GROUNDED_FALLBACK" | "AUTH_REQUIRED";
  evidence: { id: string; domain: string; sub_type: string; state: string }[];
  uncertainty: string;
  next_action: string | null;
}
