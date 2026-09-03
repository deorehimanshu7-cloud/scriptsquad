// ============================================================================
// AGRIFUR2 Shared Types
// Canonical domain contract for the Field Intelligence Operating System.
// Single source of truth shared by backend repositories, engines, adapters,
// and the frontend. Nothing in here implies data exists — states carry the
// truthfulness semantics (OBSERVED / DERIVED / ESTIMATED / REANALYSIS /
// MODEL_DERIVED / PREDICTED / SIMULATED / UNKNOWN / ...).
// ============================================================================

// ---------------------------------------------------------------------------
// Truth-state vocabulary (NO SEMANTIC LYING)
// ---------------------------------------------------------------------------
export type EvidenceState =
  | 'OBSERVED'          // physical measurement by hardware or direct observation
  | 'DERIVED'           // computed from OBSERVED evidence (e.g. NDVI from bands)
  | 'ESTIMATED'         // modelled estimate with documented model + uncertainty
  | 'HISTORICAL'        // past record, no longer current
  | 'REANALYSIS'        // reanalysis/model dataset (ERA5 etc.) — never "observed"
  | 'MODEL_DERIVED'     // output of a numerical model (weather forecast models etc.)
  | 'PREDICTED'         // forecast / forward prediction
  | 'SIMULATED'         // simulation / scenario output — never presented as real
  | 'MODELLED'          // visual/structural model (crop, roots) — not observed reality
  | 'UNKNOWN';

export type AvailabilityState =
  | 'AVAILABLE'
  | 'NO_DATA'
  | 'UNKNOWN'
  | 'AUTH_REQUIRED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'PROVIDER_ERROR'
  | 'DATA_QUALITY_FAILURE'
  | 'NOT_ASSESSED';

export type DomainState = EvidenceState | AvailabilityState | 'MISSING' | 'STALE';

// ---------------------------------------------------------------------------
// User & Authentication
// ---------------------------------------------------------------------------
export interface User {
  id: string;
  email: string;
  name?: string;
  language: 'en' | 'hi' | 'mr';
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: string;
  email: string;
  name?: string;
  language: string;
  created_at?: string;
}

export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

export interface AuthResponse {
  user: PublicUser;
  tokens: AuthTokens;
}

// ---------------------------------------------------------------------------
// Farm & Field (canonical geometry)
// ---------------------------------------------------------------------------
export interface Farm {
  id: string;
  user_id: string;
  name: string;
  location?: GeoJSON.Point;
  created_at: string;
  updated_at: string;
}

/** Field geometry summary — computed by PostGIS in production (ST_Area on a
 *  projected CRS, ST_Perimeter, ST_Centroid, ST_Envelope). In sqlite-dev mode
 *  computed by shared/geo and never claimed as PostGIS output. */
export interface GeometryMetrics {
  area_m2: number;
  area_hectares: number;
  perimeter_m: number;
  centroid: GeoJSON.Point;
  bbox: GeoJSON.BBox; // [minLng, minLat, maxLng, maxLat]
  srid: number;
  valid: boolean | null;
}

export interface Field {
  id: string;
  farm_id: string;
  user_id: string;
  name: string;
  geometry: GeoJSON.Polygon;
  metrics: GeometryMetrics;
  status: 'active' | 'inactive' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface FieldGeometryVersion {
  id: string;
  field_id: string;
  geometry: GeoJSON.Polygon;
  metrics: GeometryMetrics;
  version: number;
  created_by: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
export type ProviderStatus = AvailabilityState;

export interface ProviderCapabilities {
  search: boolean;
  retrieve: boolean;
  download: boolean;
  auth_required: boolean;
  data_types: string[];
  spatial: { aoi: boolean; point: boolean; bbox: boolean };
  temporal: { start?: string; end?: string; latency: string };
}

export interface ProviderInfo {
  id: string;
  name: string;
  type: 'satellite' | 'weather' | 'water' | 'soil' | 'terrain' | 'sensor' | 'ai' | 'map';
  status: ProviderStatus;
  status_detail?: string;
  capabilities?: ProviderCapabilities;
  last_check?: string;
  latency_ms?: number;
  requires_credentials: boolean;
  configured: boolean;
}

export interface ProviderResult<T = unknown> {
  provider: string;
  requestId: string;
  status: ProviderStatus;
  retrievedAt: string;
  data: T | null;
  provenance: Provenance;
  quality: QualityAssessment | null;
  latency_ms: number;
  error?: string;
  state?: EvidenceState;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------
export type EvidenceSource =
  | 'PHYSICAL_HARDWARE'   // 1
  | 'EARTH_OBSERVATION'   // 2
  | 'WATER'               // 3
  | 'ENVIRONMENT'         // 4 (weather/atmosphere)
  | 'AGRICULTURE'         // 5 (soil/crop/agronomy)
  | 'HISTORY'             // 6
  | 'FARMER_INPUT'        // 7 (UNVERIFIED until corroborated)
  | 'SIMULATION_VIRTUAL'; // 8

export interface QualityAssessment {
  // 0..1 when actually computed; null = NOT_ASSESSED (never a fabricated number)
  completeness: number | null;
  validity: number | null;
  freshness: number | null;
  spatial_compatibility: number | null;
  temporal_compatibility: number | null;
  source_reliability: number | null;
  calibration: number | null;
  range_plausibility: number | null;
  cross_source_agreement: number | null;
  assessed_at?: string;
  method?: string;
}

export interface EvidenceProcessing {
  processed: boolean;
  processing_time?: string;
  pipeline_version?: string;
  steps: string[];
}

export interface Provenance {
  provider?: string;
  product_id?: string;
  asset_id?: string;
  processing_chain?: string[];
  model_version?: string;
  algorithm?: string;
  algorithm_version?: string;
  parameters?: Record<string, unknown>;
  raw_data_ref?: string;
  endpoint?: string;
  metadata?: Record<string, unknown>;
  // provider-specific provenance keys are allowed and preserved verbatim
  [key: string]: unknown;
}

export interface Evidence {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  geometry?: GeoJSON.Geometry;
  source: EvidenceSource;
  provider?: string;
  observation_time: string;
  retrieved_at: string;
  measurement: Record<string, unknown>;
  unit?: string;
  state: EvidenceState;
  quality: QualityAssessment | null;
  quality_label?: 'NOT_ASSESSED' | 'ASSESSED';
  processing: EvidenceProcessing;
  provenance: Provenance;
  uncertainty?: UncertaintyDescriptor | null;
  depth_meters?: number | null;
  device_id?: string | null;
  sensor_id?: string | null;
}

export type RelationshipType =
  | 'DERIVED_FROM'
  | 'SUPPORTS'
  | 'CONTRADICTS'
  | 'CORROBORATES'
  | 'TEMPORALLY_RELATED'
  | 'SPATIALLY_OVERLAPS';

export interface EvidenceRelationship {
  id: string;
  source_evidence_id: string;
  target_evidence_id: string;
  relationship: RelationshipType;
  rationale?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Uncertainty — never a fabricated single "confidence %"
// ---------------------------------------------------------------------------
export interface UncertaintyDescriptor {
  data_quality: 'LOW' | 'MEDIUM' | 'HIGH' | 'NOT_ASSESSED';
  evidence_coverage: EvidenceCoverage;
  model_uncertainty: 'CALCULATED' | 'NOT_ASSESSED' | 'UNKNOWN';
  decision_uncertainty: 'CALCULATED' | 'NOT_ASSESSED' | 'UNKNOWN';
  explanation: string[];
}

export interface EvidenceCoverage {
  domains: Record<string, DomainState>;
  total_evidence: number;
  by_source: Record<string, number>;
  by_state: Record<string, number>;
  freshest?: string;
  stalest?: string;
  label: 'EVIDENCE_COVERAGE'; // never "confidence"
}

// ---------------------------------------------------------------------------
// World Model
// ---------------------------------------------------------------------------
export interface DomainStateBlock<T = Record<string, unknown>> {
  state: DomainState;
  state_detail?: string;
  data?: T | null;
  provider?: string;
  observation_time?: string;
  uncertainty?: UncertaintyDescriptor | null;
}

export interface WorldModel {
  field_id: string;
  state: {
    terrain: DomainStateBlock;
    crop: DomainStateBlock;
    soil: DomainStateBlock;
    water: DomainStateBlock;
    sensors: DomainStateBlock & { active_count: number; latest_readings: unknown[] };
    weather: DomainStateBlock;
    satellite: DomainStateBlock;
  };
  coverage: EvidenceCoverage;
  anomalies: Anomaly[];
  risks: Risk[];
  contradictions: Contradiction[];
  investigations: InvestigationSummary[];
  evidence_gaps: string[];
  version: number;
  last_updated: string;
}

export interface WorldModelSnapshot {
  id: string;
  field_id: string;
  world_model: WorldModel;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Anomaly / Risk / Contradiction
// ---------------------------------------------------------------------------
export type AnomalyType =
  | 'vegetation'
  | 'moisture'
  | 'rainfall'
  | 'temperature'
  | 'wind'
  | 'sensor'
  | 'water'
  | 'crop'
  | 'satellite'
  | 'cross_source'
  | 'change';

export interface Anomaly {
  id: string;
  field_id: string;
  type: AnomalyType | string;
  subtype?: string;
  timestamp: string;
  method: string;
  evidence_ids: string[];
  state: 'DETECTED' | 'INVESTIGATING' | 'CONFIRMED' | 'FALSE_POSITIVE' | 'RESOLVED';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  description: string;
  quality: QualityAssessment | null; // NOT_ASSESSED unless computed
  geometry?: GeoJSON.Geometry | null;
}

export type RiskType =
  | 'drought'
  | 'flood'
  | 'waterlogging'
  | 'heat'
  | 'water_stress'
  | 'crop_stress'
  | 'weather'
  | 'sensor_failure'
  | 'pest_disease'
  | 'nutrient'
  | 'observation_gap'
  | 'multi_anomaly'
  | 'irrigation'
  | 'wind_damage';

export type RiskSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Risk {
  id: string;
  field_id: string;
  type: RiskType | string;
  severity: RiskSeverity;
  time_horizon: string;
  affected_geometry?: GeoJSON.Geometry | null;
  evidence_ids: string[];
  status: 'ACTIVE' | 'MITIGATED' | 'RESOLVED' | 'EXPIRED';
  description: string;
  trigger_reason: string;
  uncertainty: 'NOT_ASSESSED' | 'UNKNOWN';
  created_at: string;
}

export interface Contradiction {
  id: string;
  field_id: string;
  type: string;
  description: string;
  evidence_a_id?: string;
  evidence_b_id?: string;
  source_a?: string;
  source_b?: string;
  detected_at: string;
  state: 'DETECTED' | 'INVESTIGATING' | 'RESOLVED' | 'UNRESOLVABLE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  hypothesis?: string;
}

// ---------------------------------------------------------------------------
// Investigation / Hypothesis / Next-best-observation
// ---------------------------------------------------------------------------
export type InvestigationStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'ESCALATED' | 'CLOSED';

export interface Investigation {
  id: string;
  field_id: string;
  user_id: string;
  title: string;
  question: string;
  trigger_type: string;
  trigger_data?: Record<string, unknown>;
  status: InvestigationStatus;
  hypotheses: Hypothesis[];
  evidence_ids: string[];
  supporting: string[];
  conflicting: string[];
  missing: string[];
  next_observations: NextBestObservation[];
  conclusion?: string;
  action_recommendation?: string;
  created_at: string;
  updated_at: string;
}

export interface InvestigationSummary {
  id: string;
  field_id: string;
  title: string;
  question: string;
  status: InvestigationStatus;
  trigger_type: string;
  hypothesis_count: number;
  created_at: string;
  updated_at: string;
}

export interface Hypothesis {
  id: string;
  investigation_id: string;
  description: string;
  supporting_evidence: string[];
  conflicting_evidence: string[];
  missing_evidence: string[];
  next_observation: string;
  probability: null | number; // only when a calibrated model produced it
  status: 'PROPOSED' | 'TESTING' | 'SUPPORTED' | 'REJECTED';
  created_at: string;
}

export interface NextBestObservation {
  id: string;
  investigation_id: string;
  candidate: string;
  rationale: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  cost?: string;
  delay?: string;
}

// ---------------------------------------------------------------------------
// Sensors / Devices / Observations
// ---------------------------------------------------------------------------
export interface Device {
  id: string;
  user_id: string;
  farm_id?: string;
  field_id?: string;
  name: string;
  type: string;
  serial_number?: string;
  firmware_version?: string;
  hardware_version?: string;
  status: 'active' | 'inactive' | 'error' | 'offline';
  location?: GeoJSON.Point;
  last_seen_at?: string;
  battery?: number;
  created_at: string;
  updated_at: string;
}

export interface Sensor {
  id: string;
  device_id: string;
  sensor_type: string;
  unit?: string;
  min_value?: number;
  max_value?: number;
  calibration_version: number;
  status: string;
  created_at: string;
}

export interface Observation {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  device_id?: string;
  deployment_id?: string;
  sensor_id?: string;
  sensor_type?: string;
  geometry?: GeoJSON.Point;
  depth_meters?: number;
  timestamp: string;
  value: number;
  unit: string;
  quality: 'VALID' | 'OUT_OF_RANGE' | 'STALE' | 'DUPLICATE' | 'INVALID' | 'UNKNOWN';
  calibration_version?: number;
  firmware_version?: string;
  provenance: Record<string, unknown>;
  ingestion_metadata?: Record<string, unknown>;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------
export interface WeatherCurrent {
  temperature_c: number;
  humidity_pct: number;
  wind_speed_kmh: number;
  precipitation_mm: number;
  pressure_hpa?: number;
  observed_at: string;
}

export interface WeatherDaily {
  date: string;
  temp_max_c: number;
  temp_min_c: number;
  precipitation_sum_mm: number;
  wind_speed_max_kmh?: number;
}

export interface WeatherHourly {
  time: string;
  temperature_c: number;
  humidity_pct: number;
  precipitation_mm: number;
  wind_speed_kmh?: number;
}

export interface WeatherDataset {
  provider: string;
  dataset: string;
  semantics: 'OBSERVED' | 'MODEL_DERIVED' | 'PREDICTED' | 'REANALYSIS';
  current: WeatherCurrent | null;
  daily: WeatherDaily[];
  hourly: WeatherHourly[];
  coordinates: { lat: number; lng: number };
  retrieved_at: string;
}

// ---------------------------------------------------------------------------
// Soil / Water / Terrain (values always carry state + provenance)
// ---------------------------------------------------------------------------
export interface SoilProperty {
  property: string;
  value: number | null;
  unit: string;
  state: EvidenceState;
  source?: string;
  timestamp?: string;
  quality: QualityAssessment | null;
  uncertainty?: { value: number; unit: string } | null;
  provenance?: Provenance;
}

export interface SoilDataset {
  field_id: string;
  properties: SoilProperty[];
  state: DomainState;
  note?: string;
}

export interface WaterDataset {
  field_id: string;
  domains: {
    surface_water: DomainStateBlock;
    groundwater: DomainStateBlock;
    irrigation: DomainStateBlock;
    drainage: DomainStateBlock;
    water_stress: DomainStateBlock;
  };
}

export interface TerrainDataset {
  field_id: string;
  state: DomainState;
  elevation_m?: number;
  slope_deg?: number;
  aspect_deg?: number;
  source?: string;
  timestamp?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Simulation (SIMULATED world only — never mutates live state)
// ---------------------------------------------------------------------------
export interface Simulation {
  id: string;
  field_id: string;
  user_id: string;
  name: string;
  scenario: Record<string, unknown>;
  assumptions: string[];
  baseline_world_model_id?: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  result?: Record<string, unknown>;
  executed_at?: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Farmer observations / Verification / Farm memory
// ---------------------------------------------------------------------------
export type FarmerObservationStatus = 'UNVERIFIED' | 'CORROBORATED' | 'CONTRADICTED';

export interface FarmerObservation {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  text: string;
  location?: GeoJSON.Point;
  verification: FarmerObservationStatus;
  corroborating_evidence_ids: string[];
  created_at: string;
}

export interface Verification {
  id: string;
  field_id: string;
  entity_type: string;
  entity_id: string;
  expected_outcome?: Record<string, unknown>;
  actual_outcome?: Record<string, unknown>;
  evidence_ids: string[];
  result?: 'CONFIRMED' | 'REJECTED' | 'PARTIAL' | 'PENDING';
  verified_at?: string;
  created_at: string;
}

export interface FarmMemoryEntry {
  id: string;
  field_id: string;
  event: string;
  evidence_ids: string[];
  reasoning: string;
  action: string;
  expected_outcome: Record<string, unknown>;
  actual_outcome: Record<string, unknown>;
  verification_result: string;
  learned_rule?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
export interface AssistantSession {
  id: string;
  user_id: string;
  field_id?: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: { name: string; args: Record<string, unknown>; result?: unknown }[];
  evidence_refs: string[];
  created_at: string;
}

// ---------------------------------------------------------------------------
// Events / Jobs / Audit
// ---------------------------------------------------------------------------
export type SystemEventType =
  | 'FIELD_CREATED'
  | 'FIELD_UPDATED'
  | 'FIELD_DELETED'
  | 'SENSOR_CONNECTED'
  | 'OBSERVATION_RECEIVED'
  | 'SATELLITE_ACQUIRED'
  | 'SATELLITE_PROCESSED'
  | 'ANOMALY_DETECTED'
  | 'RISK_UPDATED'
  | 'CONTRADICTION_DETECTED'
  | 'INVESTIGATION_CREATED'
  | 'HYPOTHESIS_CREATED'
  | 'ACTION_RECOMMENDED'
  | 'ACTION_APPROVED'
  | 'ACTION_EXECUTED'
  | 'OUTCOME_OBSERVED'
  | 'VERIFICATION_COMPLETED'
  | 'WORLD_MODEL_UPDATED'
  | 'EVIDENCE_ADDED'
  | 'ANALYSIS_COMPLETED'
  | 'SIMULATION_COMPLETED';

export interface SystemEvent {
  id: string;
  type: SystemEventType | string;
  field_id?: string;
  user_id?: string;
  data: Record<string, unknown>;
  created_at: string;
}

export interface Job {
  id: string;
  type: string;
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'RETRYING';
  field_id?: string;
  params: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  result?: Record<string, unknown>;
  error?: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------
export interface ApiSuccess<T = unknown> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiError;

export * from './geo';

