/**
 * AGRIFUR2 SQLite development-mode database (DATABASE_MODE=sqlite-dev)
 *
 * ⚠️ DEVELOPMENT FALLBACK ONLY — never a production store, never claimed as
 * PostGIS-backed. When PostgreSQL + PostGIS is reachable the repository layer
 * uses the canonical PostGIS schema (database/migrations/001_initial_schema.sql)
 * and all spatial calculations are performed by PostGIS.
 *
 * This module mirrors the PostGIS schema table-for-table and column-for-column
 * so the repository layer serves identical domain/API shapes in both modes.
 * Type mapping: UUID→TEXT, TIMESTAMPTZ→TEXT(ISO), DOUBLE PRECISION→REAL,
 * INTEGER→INTEGER, VARCHAR→TEXT, BOOLEAN→INTEGER, JSONB→TEXT, GEOMETRY→TEXT
 * (GeoJSON). A parity test asserts every sqlite table/column exists in the
 * PostGIS migration.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export function defaultDbPath(): string {
  return process.env.DB_FILE || path.join(__dirname, '../../agrifur2.db');
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = defaultDbPath();
    const useMemory = process.env.NODE_ENV === 'test' && !process.env.DB_FILE;
    if (!useMemory && process.env.NODE_ENV === 'test' && fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath); // fresh DB per test run
    }
    db = new Database(useMemory ? ':memory:' : dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initializeSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Columns that are JSONB in PostGIS mode and TEXT here; the driver parses them
 * on read and stringifies on write so callers see identical shapes.
 * Geometry columns are deliberately NOT in this registry (repos handle them).
 */
export const JSON_COLUMNS: Record<string, string[]> = {
  farms: ['location'],
  refresh_tokens: [],
  users: [],
  fields: [],
  field_geometry_versions: [],
  crop_cycles: [],
  crop_states: ['observations'],
  devices: [],
  device_deployments: [],
  sensors: [],
  sensor_calibrations: ['calibration_data'],
  observations: ['provenance', 'ingestion_metadata'],
  telemetry_raw: ['payload', 'outcome'],
  device_heartbeats: ['payload'],
  device_events: ['data'],
  commands: ['params'],
  providers: ['config'],
  provider_requests: ['params', 'response_data'],
  provider_health: [],
  satellite_products: ['assets', 'metadata'],
  evidence: ['measurement', 'quality', 'processing', 'provenance', 'uncertainty'],
  evidence_relationships: [],
  weather_observations: ['data'],
  water_observations: ['data'],
  soil_observations: ['quality', 'uncertainty', 'provenance'],
  terrain_products: ['data'],
  world_model_states: ['world_model'],
  world_model_zones: ['properties'],
  anomalies: ['evidence_ids', 'quality'],
  risks: ['evidence_ids'],
  uncertainties: ['assessment'],
  contradictions: [],
  investigations: ['trigger_data', 'evidence_ids', 'supporting_ids', 'conflicting_ids', 'missing', 'next_observations'],
  hypotheses: ['supporting_evidence', 'conflicting_evidence', 'missing_evidence'],
  next_best_observations: [],
  recommendations: ['expected_outcome'],
  actions: ['expected_outcome'],
  verifications: ['expected_outcome', 'actual_outcome', 'evidence_ids'],
  farm_memory: ['evidence_ids', 'expected_outcome', 'actual_outcome'],
  farmer_observations: ['corroborating_evidence_ids'],
  conversations: [],
  conversation_messages: ['tool_calls', 'evidence_refs'],
  simulations: ['scenario', 'assumptions', 'result'],
  events: ['data'],
  jobs: ['params', 'result'],
  notifications: [],
  audit_logs: ['details'],
};

// column definitions aligned with 001_initial_schema.sql (PostGIS)
interface TableDef {
  name: string;
  cols: string[]; // "name TYPE ..." with sqlite type mapping applied
  indexes?: string[][];
}

const T = (name: string, cols: string[], indexes?: string[][]): TableDef => ({ name, cols, indexes });

const SCHEMA: TableDef[] = [
  T('users', [
    'id TEXT PRIMARY KEY', 'email TEXT UNIQUE NOT NULL', 'password_hash TEXT NOT NULL',
    'name TEXT', "language TEXT NOT NULL DEFAULT 'en'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ]),
  T('refresh_tokens', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE',
    'token_hash TEXT NOT NULL', 'expires_at TEXT NOT NULL',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['user_id']]),
  T('farms', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE',
    'name TEXT NOT NULL', 'location TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['user_id']]),
  T('fields', [
    'id TEXT PRIMARY KEY', 'farm_id TEXT NOT NULL REFERENCES farms(id) ON DELETE CASCADE',
    'user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE',
    'name TEXT NOT NULL', 'geometry TEXT NOT NULL', 'geometry_valid INTEGER',
    'area_m2 REAL', 'area_hectares REAL', 'perimeter_m REAL',
    'centroid TEXT', 'bbox TEXT', 'srid INTEGER NOT NULL DEFAULT 4326',
    "status TEXT NOT NULL DEFAULT 'active'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['farm_id'], ['user_id']]),
  T('field_geometry_versions', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'geometry TEXT NOT NULL', 'version INTEGER NOT NULL',
    'created_by TEXT NOT NULL REFERENCES users(id)',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('crop_cycles', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'crop_type TEXT NOT NULL', 'variety TEXT', 'season TEXT',
    'sowing_date TEXT', 'expected_harvest_date TEXT', 'actual_harvest_date TEXT',
    "status TEXT NOT NULL DEFAULT 'active'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('crop_states', [
    'id TEXT PRIMARY KEY', 'crop_cycle_id TEXT NOT NULL REFERENCES crop_cycles(id) ON DELETE CASCADE',
    'growth_stage TEXT', 'health_index REAL', 'observations TEXT NOT NULL DEFAULT \'{}\'',
    "state TEXT NOT NULL DEFAULT 'UNKNOWN'",
    'recorded_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['crop_cycle_id']]),
  T('devices', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE',
    'farm_id TEXT REFERENCES farms(id) ON DELETE SET NULL',
    'field_id TEXT REFERENCES fields(id) ON DELETE SET NULL',
    'name TEXT NOT NULL', 'type TEXT NOT NULL', 'serial_number TEXT',
    'firmware_version TEXT', 'hardware_version TEXT',
    "status TEXT NOT NULL DEFAULT 'inactive'", 'location TEXT', 'api_key TEXT', 'last_seen_at TEXT', 'battery REAL',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['user_id'], ['field_id']]),
  T('device_deployments', [
    'id TEXT PRIMARY KEY', 'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
    'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'deployment_date TEXT NOT NULL', 'removal_date TEXT', 'location TEXT', 'depth_meters REAL',
    "status TEXT NOT NULL DEFAULT 'active'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('sensors', [
    'id TEXT PRIMARY KEY', 'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
    'sensor_type TEXT NOT NULL', 'unit TEXT', 'min_value REAL', 'max_value REAL',
    'calibration_version INTEGER NOT NULL DEFAULT 1',
    "status TEXT NOT NULL DEFAULT 'active'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['device_id']]),
  T('sensor_calibrations', [
    'id TEXT PRIMARY KEY', 'sensor_id TEXT NOT NULL REFERENCES sensors(id) ON DELETE CASCADE',
    'version INTEGER NOT NULL', 'calibration_data TEXT NOT NULL DEFAULT \'{}\'',
    'method TEXT', 'valid_until TEXT',
    'calibrated_by TEXT', 'calibrated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['sensor_id']]),
  T('observations', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id)',
    'farm_id TEXT NOT NULL REFERENCES farms(id)',
    'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'device_id TEXT REFERENCES devices(id)',
    'deployment_id TEXT REFERENCES device_deployments(id)',
    'sensor_id TEXT REFERENCES sensors(id)', 'sensor_type TEXT', 'geometry TEXT', 'depth_meters REAL',
    'timestamp TEXT NOT NULL', 'value REAL NOT NULL', 'unit TEXT',
    "quality TEXT NOT NULL DEFAULT 'UNKNOWN'", 'calibration_version INTEGER', 'firmware_version TEXT',
    'provenance TEXT NOT NULL DEFAULT \'{}\'', 'ingestion_metadata TEXT NOT NULL DEFAULT \'{}\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['sensor_id'], ['device_id']]),
  T('telemetry_raw', [
    'id TEXT PRIMARY KEY', 'message_id TEXT', 'device_id TEXT REFERENCES devices(id) ON DELETE SET NULL',
    'field_id TEXT REFERENCES fields(id) ON DELETE SET NULL', 'topic TEXT',
    'payload TEXT NOT NULL DEFAULT \'{}\'',
    'received_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    "state TEXT NOT NULL DEFAULT 'RECEIVED'", 'outcome TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['device_id'], ['received_at']]),
  T('device_heartbeats', [
    'id TEXT PRIMARY KEY', 'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
    'recorded_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'battery REAL', 'signal_strength REAL', 'uptime_s REAL', 'firmware_version TEXT',
    'payload TEXT NOT NULL DEFAULT \'{}\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['device_id']]),
  T('device_events', [
    'id TEXT PRIMARY KEY', 'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
    'type TEXT NOT NULL', 'occurred_at TEXT NOT NULL',
    'data TEXT NOT NULL DEFAULT \'{}\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['device_id']]),
  T('commands', [
    'id TEXT PRIMARY KEY', 'device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE',
    'field_id TEXT REFERENCES fields(id) ON DELETE SET NULL',
    'user_id TEXT REFERENCES users(id)',
    'command TEXT NOT NULL', 'params TEXT NOT NULL DEFAULT \'{}\'',
    "status TEXT NOT NULL DEFAULT 'QUEUED'",
    'requested_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'sent_at TEXT', 'acked_at TEXT', 'expires_at TEXT', 'ack_message_id TEXT', 'error TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['device_id']]),
  T('providers', [
    'id TEXT PRIMARY KEY', 'name TEXT NOT NULL', 'type TEXT NOT NULL',
    "status TEXT NOT NULL DEFAULT 'UNKNOWN'", 'config TEXT NOT NULL DEFAULT \'{}\'', 'last_check TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ]),
  T('provider_requests', [
    'id TEXT PRIMARY KEY', 'provider_id TEXT NOT NULL REFERENCES providers(id)',
    'request_type TEXT NOT NULL', 'params TEXT NOT NULL DEFAULT \'{}\'',
    'status TEXT NOT NULL', 'response_data TEXT', 'error_message TEXT', 'latency_ms INTEGER',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['provider_id']]),
  T('provider_health', [
    'id TEXT PRIMARY KEY', 'provider_id TEXT NOT NULL REFERENCES providers(id)',
    'status TEXT NOT NULL', 'latency_ms INTEGER', 'error_rate REAL', 'success_rate REAL',
    'last_error TEXT', 'checked_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['provider_id']]),
  T('satellite_products', [
    'id TEXT PRIMARY KEY', 'provider_id TEXT NOT NULL', 'collection TEXT NOT NULL',
    'product_id TEXT NOT NULL', 'field_id TEXT REFERENCES fields(id) ON DELETE CASCADE',
    'geometry TEXT', 'cloud_cover REAL', 'observation_date TEXT NOT NULL',
    'assets TEXT NOT NULL DEFAULT \'{}\'', 'metadata TEXT NOT NULL DEFAULT \'{}\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['observation_date']]),
  T('evidence', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id)',
    'farm_id TEXT NOT NULL REFERENCES farms(id)',
    'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'source TEXT NOT NULL', 'provider TEXT', 'geometry TEXT',
    'observation_time TEXT NOT NULL', 'retrieved_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'measurement TEXT NOT NULL', 'unit TEXT',
    "state TEXT NOT NULL DEFAULT 'UNKNOWN'", 'quality TEXT', 'processing TEXT NOT NULL DEFAULT \'{"processed":false,"steps":[]}\'',
    'provenance TEXT NOT NULL DEFAULT \'{}\'', 'uncertainty TEXT', 'depth_meters REAL',
    'device_id TEXT', 'sensor_id TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['source'], ['observation_time']]),
  T('evidence_relationships', [
    'id TEXT PRIMARY KEY', 'source_evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE',
    'target_evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE',
    'relationship TEXT NOT NULL', 'rationale TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['source_evidence_id'], ['target_evidence_id']]),
  T('weather_observations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'provider TEXT', 'timestamp TEXT NOT NULL', 'kind TEXT NOT NULL', 'semantics TEXT NOT NULL',
    'data TEXT NOT NULL', 'retrieved_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('water_observations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'domain TEXT NOT NULL', 'state TEXT NOT NULL', 'data TEXT NOT NULL DEFAULT \'{}\'',
    'provider TEXT', 'observed_at TEXT', 'retrieved_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('soil_observations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'property TEXT NOT NULL', 'value REAL', 'unit TEXT', 'state TEXT NOT NULL', 'source TEXT',
    'timestamp TEXT', 'quality TEXT', 'uncertainty TEXT', 'provenance TEXT NOT NULL DEFAULT \'{}\'',
    'retrieved_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('terrain_products', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'kind TEXT NOT NULL', 'state TEXT NOT NULL', 'data TEXT NOT NULL DEFAULT \'{}\'',
    'provider TEXT', 'retrieved_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('world_model_states', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'world_model TEXT NOT NULL', 'version INTEGER NOT NULL DEFAULT 1',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('world_model_zones', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'geometry TEXT', 'properties TEXT NOT NULL DEFAULT \'{}\'',
    "state TEXT NOT NULL DEFAULT 'UNKNOWN'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('anomalies', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'type TEXT NOT NULL', 'subtype TEXT', 'timestamp TEXT NOT NULL', 'method TEXT NOT NULL',
    'evidence_ids TEXT NOT NULL DEFAULT \'[]\'', "state TEXT NOT NULL DEFAULT 'DETECTED'",
    'severity TEXT', 'quality TEXT', 'geometry TEXT', 'description TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['type']]),
  T('risks', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'type TEXT NOT NULL', 'severity TEXT NOT NULL', 'time_horizon TEXT',
    'affected_geometry TEXT', 'evidence_ids TEXT NOT NULL DEFAULT \'[]\'',
    "status TEXT NOT NULL DEFAULT 'ACTIVE'", 'description TEXT', 'trigger_reason TEXT',
    "uncertainty TEXT NOT NULL DEFAULT 'NOT_ASSESSED'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['status']]),
  T('uncertainties', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'assessment TEXT NOT NULL', 'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('contradictions', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'type TEXT NOT NULL', 'description TEXT NOT NULL', 'evidence_a_id TEXT', 'evidence_b_id TEXT',
    'source_a TEXT', 'source_b TEXT', 'detected_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    "state TEXT NOT NULL DEFAULT 'DETECTED'", "severity TEXT NOT NULL DEFAULT 'LOW'", 'hypothesis TEXT',
  ], [['field_id'], ['state']]),
  T('investigations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'user_id TEXT NOT NULL REFERENCES users(id)', 'title TEXT NOT NULL',
    "question TEXT NOT NULL DEFAULT ''", "trigger_type TEXT NOT NULL DEFAULT 'MANUAL'",
    'trigger_data TEXT NOT NULL DEFAULT \'{}\'', "status TEXT NOT NULL DEFAULT 'OPEN'",
    'hypotheses TEXT NOT NULL DEFAULT \'[]\'', 'evidence_ids TEXT NOT NULL DEFAULT \'[]\'', 'supporting_ids TEXT NOT NULL DEFAULT \'[]\'',
    'conflicting_ids TEXT NOT NULL DEFAULT \'[]\'', 'missing TEXT NOT NULL DEFAULT \'[]\'',
    'next_observations TEXT NOT NULL DEFAULT \'[]\'', 'conclusion TEXT', 'action_recommendation TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['status']]),
  T('hypotheses', [
    'id TEXT PRIMARY KEY', 'investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE',
    'description TEXT NOT NULL', 'supporting_evidence TEXT NOT NULL DEFAULT \'[]\'',
    'conflicting_evidence TEXT NOT NULL DEFAULT \'[]\'', 'missing_evidence TEXT NOT NULL DEFAULT \'[]\'',
    'next_observation TEXT', 'probability REAL', "status TEXT NOT NULL DEFAULT 'PROPOSED'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['investigation_id']]),
  T('next_best_observations', [
    'id TEXT PRIMARY KEY', 'investigation_id TEXT NOT NULL REFERENCES investigations(id) ON DELETE CASCADE',
    'candidate TEXT NOT NULL', 'rationale TEXT', "priority TEXT NOT NULL DEFAULT 'MEDIUM'",
    'cost TEXT', 'delay TEXT', 'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['investigation_id']]),
  T('recommendations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'investigation_id TEXT REFERENCES investigations(id) ON DELETE SET NULL',
    'title TEXT NOT NULL', 'description TEXT', 'expected_outcome TEXT NOT NULL DEFAULT \'{}\'',
    "status TEXT NOT NULL DEFAULT 'OPEN'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('actions', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'recommendation_id TEXT REFERENCES recommendations(id) ON DELETE SET NULL',
    'title TEXT NOT NULL', "status TEXT NOT NULL DEFAULT 'RECOMMENDED'",
    'expected_outcome TEXT NOT NULL DEFAULT \'{}\'', 'executed_at TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('verifications', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'entity_type TEXT NOT NULL', 'entity_id TEXT NOT NULL',
    'expected_outcome TEXT NOT NULL DEFAULT \'{}\'', 'actual_outcome TEXT NOT NULL DEFAULT \'{}\'',
    'evidence_ids TEXT NOT NULL DEFAULT \'[]\'', "result TEXT NOT NULL DEFAULT 'PENDING'",
    'verified_at TEXT', 'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('farm_memory', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'event TEXT NOT NULL', 'evidence_ids TEXT NOT NULL DEFAULT \'[]\'', 'reasoning TEXT',
    'action TEXT', 'expected_outcome TEXT NOT NULL DEFAULT \'{}\'',
    'actual_outcome TEXT NOT NULL DEFAULT \'{}\'', 'verification_result TEXT', 'learned_rule TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('farmer_observations', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id)',
    'farm_id TEXT NOT NULL REFERENCES farms(id)',
    'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'text TEXT NOT NULL', 'location TEXT', "verification TEXT NOT NULL DEFAULT 'UNVERIFIED'",
    'corroborating_evidence_ids TEXT NOT NULL DEFAULT \'[]\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('conversations', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id)',
    'field_id TEXT REFERENCES fields(id) ON DELETE CASCADE',
    "language TEXT NOT NULL DEFAULT 'en'",
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['user_id']]),
  T('conversation_messages', [
    'id TEXT PRIMARY KEY', 'conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE',
    'role TEXT NOT NULL', 'content TEXT NOT NULL', 'tool_calls TEXT NOT NULL DEFAULT \'[]\'',
    'evidence_refs TEXT NOT NULL DEFAULT \'[]\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['conversation_id']]),
  T('simulations', [
    'id TEXT PRIMARY KEY', 'field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE',
    'user_id TEXT NOT NULL REFERENCES users(id)', 'name TEXT',
    'scenario TEXT NOT NULL DEFAULT \'{}\'', 'assumptions TEXT NOT NULL DEFAULT \'[]\'',
    "status TEXT NOT NULL DEFAULT 'PENDING'", 'result TEXT NOT NULL DEFAULT \'{}\'', 'executed_at TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id']]),
  T('events', [
    'id TEXT PRIMARY KEY', 'type TEXT NOT NULL', 'field_id TEXT', 'user_id TEXT',
    'data TEXT NOT NULL DEFAULT \'{}\'',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['field_id'], ['type'], ['created_at']]),
  T('jobs', [
    'id TEXT PRIMARY KEY', 'type TEXT NOT NULL', "status TEXT NOT NULL DEFAULT 'PENDING'",
    'field_id TEXT', 'params TEXT NOT NULL DEFAULT \'{}\'',
    'attempts INTEGER NOT NULL DEFAULT 0', 'max_attempts INTEGER NOT NULL DEFAULT 3',
    'result TEXT', 'error TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
    'updated_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['status'], ['type']]),
  T('notifications', [
    'id TEXT PRIMARY KEY', 'user_id TEXT NOT NULL REFERENCES users(id)',
    'type TEXT NOT NULL', 'title TEXT NOT NULL', 'message TEXT',
    'read INTEGER NOT NULL DEFAULT 0',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ], [['user_id']]),
  T('audit_logs', [
    'id TEXT PRIMARY KEY', 'user_id TEXT', 'action TEXT NOT NULL', 'entity_type TEXT',
    'entity_id TEXT', 'details TEXT NOT NULL DEFAULT \'{}\'', 'request_id TEXT',
    'created_at TEXT NOT NULL DEFAULT (datetime(\'now\'))',
  ]),
];

export function initializeSchema(db: Database.Database): void {
  const statements: string[] = [];
  for (const table of SCHEMA) {
    const cols = table.cols.map((c) => c).join(',\n    ');
    statements.push(`CREATE TABLE IF NOT EXISTS ${table.name} (\n    ${cols}\n  );`);
    for (const idx of table.indexes || []) {
      const name = `idx_${table.name}_${idx.join('_')}`;
      statements.push(`CREATE INDEX IF NOT EXISTS ${name} ON ${table.name}(${idx.join(',')});`);
    }
  }
  db.exec(statements.join('\n\n'));
}

// ─── Row (de)serialization for JSONB-mirror columns ────────────────────────
export function tableJsonColumns(table: string): string[] {
  return JSON_COLUMNS[table] || [];
}

export function toStore(table: string, value: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...value };
  for (const col of tableJsonColumns(table)) {
    if (out[col] !== undefined && out[col] !== null && typeof out[col] !== 'string') {
      out[col] = JSON.stringify(out[col]);
    }
  }
  return out;
}

export function fromStore(table: string, row: Record<string, any> | undefined | null): Record<string, any> | null {
  if (!row) return null;
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'string' && tableJsonColumns(table).includes(k)) {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else if (v !== null && typeof v === 'string' && isIsoDate(v)) {
      out[k] = v; // keep ISO text
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(s);
}

export function generateId(): string {
  return uuidv4();
}

// ─── Password helpers (pbkdf2-sha512, constant-time compare) ───────────────
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const verify = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(verify, 'hex');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
