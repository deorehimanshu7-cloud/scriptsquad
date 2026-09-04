/** Client-side types mirroring the API DTOs (contracts package is shared). */

export type TruthState =
  | "OBSERVED"
  | "DERIVED"
  | "ESTIMATED"
  | "HISTORICAL"
  | "PREDICTED"
  | "SIMULATED"
  | "UNKNOWN";

export type ProviderState =
  | "AVAILABLE"
  | "NO_DATA"
  | "AUTH_REQUIRED"
  | "NOT_CONFIGURED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "UNAVAILABLE"
  | "DATA_QUALITY_FAILURE";

export type Domain =
  | "sensor"
  | "satellite"
  | "water"
  | "environment"
  | "soil"
  | "terrain"
  | "crop"
  | "history"
  | "farmer"
  | "simulation"
  | "weather";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type Severity = "info" | "low" | "medium" | "high";
export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "RETRYING"
  | "BLOCKED"
  | "NO_DATA"
  | "AUTH_REQUIRED";

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
}

export interface FieldRecord {
  id: string;
  farm_id: string;
  farm_name: string | null;
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

export interface Provenance {
  provider: string;
  model?: string;
  model_version?: string;
  processing?: string;
  access_url?: string;
  credential_gated?: boolean;
  note?: string;
}

export interface EvidenceRecord {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  domain: Domain;
  source: string;
  source_type: string;
  sub_type: string;
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

export interface ProviderHealthRecord {
  provider: string;
  status: ProviderState;
  last_check_at: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  latency_ms: number | null;
  auth_state: "none" | "configured" | "required" | "unknown";
  note: string | null;
}

export interface ProviderMeta {
  id: string;
  name: string;
  description: string;
  auth_state: string;
  docs_url?: string;
  health?: ProviderHealthRecord;
}

export interface JobRecord {
  id: string;
  user_id: string | null;
  field_id: string | null;
  type: string;
  status: JobStatus;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  retry_count: number;
  detail: unknown;
  created_at: string;
}

export interface SystemEvent {
  id: string;
  user_id: string | null;
  farm_id: string | null;
  field_id: string | null;
  type: string;
  payload: unknown;
  created_at: string;
}

export interface SatelliteProduct {
  id: string;
  provider: string;
  satellite: string;
  product_id: string;
  collection: string | null;
  acquired_at: string;
  cloud_cover: number | null;
  resolution_m: number | null;
  processing_level: string | null;
  platform?: string | null;
  product_type?: string | null;
  polarization?: string | null;
  field_intersection_pct?: number | null;
  geometry: unknown;
  assets: { href: string; type: string; title: string; credential_gated?: boolean }[];
  preview_available: number;
  state: string;
  status: string;
  source_url: string | null;
  created_at: string;
}

export interface DeviceRecord {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  external_id: string | null;
  name: string;
  kind: "sensor_node" | "voice_device" | "gateway";
  firmware_version: string | null;
  status: "registered" | "online" | "offline" | "error";
  /** computed from real last_seen_at — never shows ONLINE forever after disconnect */
  effective_status: "registered" | "online" | "stale" | "offline" | "error";
  seconds_since_seen: number | null;
  last_seen_at: string | null;
  telemetry_count: number;
  last_telemetry_at: string | null;
  metadata: unknown;
  created_at: string;
}

export interface ObservationRow {
  id: string;
  device_id: string;
  sensor_type: string;
  value: number;
  unit: string | null;
  observed_at: string;
  quality: string | null;
}

export interface AnomalyRecord {
  id: string;
  field_id: string;
  kind: string;
  severity: Severity;
  level: string;
  description: string;
  evidence_ids: string;
  trigger: string;
  status: string;
  detected_at: string;
  resolved_at: string | null;
}

export interface RiskRecord {
  id: string;
  field_id: string;
  risk_type: string;
  level: RiskLevel;
  reason: string;
  evidence_ids: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ActionRecord {
  id: string;
  field_id: string;
  kind: string;
  title: string;
  description: string;
  status: "recommended" | "taken" | "verified" | "dismissed";
  recommendation_from: string | null;
  risk_type?: string | null;
  risk_level?: RiskLevel | null;
  evidence_ids?: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationRecord {
  id: string;
  action_id: string | null;
  outcome: string | null;
  state: string;
  verified_at: string;
  action_title?: string | null;
}

export interface EvidenceRelationship {
  id: string;
  evidence_a: string;
  evidence_b: string;
  relationship: string;
  reason: string | null;
  created_at: string;
  a_sub: string | null;
  a_domain: string | null;
  a_desc: string | null;
  b_sub: string | null;
  b_domain: string | null;
  b_desc: string | null;
}

export interface UncertaintyRecord {
  id: string;
  field_id: string;
  kind: string;
  domain: Domain | null;
  level: RiskLevel;
  reason: string;
  created_at: string;
}

export interface ContradictionRecord {
  id: string;
  field_id: string;
  evidence_a: string;
  evidence_b: string;
  relationship: string;
  reason: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface Hypothesis {
  id: string;
  investigation_id: string;
  statement: string;
  status: "proposed" | "testing" | "supported" | "rejected" | "inconclusive";
  tested_with: string | null;
  created_at: string;
  updated_at: string;
}

export interface Investigation {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  title: string;
  problem: string;
  status: "open" | "collecting_evidence" | "hypothesis_testing" | "resolved" | "escalated" | "closed";
  trigger: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  hypotheses: Hypothesis[];
  next_observations: { id: string; rank: string; observation: string; reason: string; status: string }[];
  linked_evidence: EvidenceRecord[];
}

export interface FarmerObservation {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  text: string;
  tags: string[];
  state: string;
  verified: number;
  verified_by: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface MemoryEntry {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  kind: string;
  ref_id: string | null;
  title: string;
  summary: string | null;
  happened_at: string;
  created_at: string;
}

export interface SimulationRecord {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  name: string;
  scenario: string;
  model: string;
  model_version: string;
  inputs: unknown;
  assumptions: string;
  limitations: string;
  status: string;
  created_at: string;
}

export interface AssistantSession {
  id: string;
  user_id: string;
  field_id: string | null;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  meta: unknown;
  created_at: string;
}

export interface AssistantAnswer {
  answer: string;
  mode: "LLM" | "LOCAL_GROUNDED_FALLBACK" | "AUTH_REQUIRED";
  evidence: { id: string; domain: string; sub_type: string; state: string }[];
  uncertainty: string;
  next_action: string | null;
}

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
  simulation: "Simulation",
  weather: "Weather",
};

export const TRUTH_LABELS: Record<TruthState, string> = {
  OBSERVED: "Observed",
  DERIVED: "Derived",
  ESTIMATED: "Estimated",
  HISTORICAL: "Historical",
  PREDICTED: "Predicted",
  SIMULATED: "Simulated",
  UNKNOWN: "Unknown",
};