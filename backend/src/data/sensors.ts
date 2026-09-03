/**
 * Devices, deployments, sensors, calibrations, raw telemetry, heartbeats,
 * device events, downlink commands and observations repository.
 * Telemetry is transport-agnostic: HTTPS or MQTT → ingestion → this repo.
 */
import { dbAll, dbGet, dbRun, GEO } from './db';
import { generateId } from '../database/sqlite';

// ── Row types ───────────────────────────────────────────────────────────────
export interface HeartbeatRow {
  id: string; device_id: string; recorded_at: string;
  battery?: number | null; signal_strength?: number | null; uptime_s?: number | null;
  firmware_version?: string | null; payload: Record<string, unknown>; created_at: string;
}

export interface RawTelemetryRow {
  id: string; message_id?: string | null; device_id?: string | null; field_id?: string | null;
  topic?: string | null; payload: Record<string, unknown>; received_at: string;
  state: string; outcome?: Record<string, unknown> | null; created_at: string;
}

export interface DeviceEventRow {
  id: string; device_id: string; type: string; occurred_at: string;
  data: Record<string, unknown>; created_at: string;
}

export interface CommandRow {
  id: string; device_id: string; field_id?: string | null; user_id?: string | null;
  command: string; params: Record<string, unknown>; status: string;
  requested_at: string; sent_at?: string | null; acked_at?: string | null;
  expires_at?: string | null; ack_message_id?: string | null; error?: string | null;
  created_at: string; updated_at: string;
}

// ── Device state derivation (truthful — from real activity) ───────────────
export type DerivedDeviceState = 'ONLINE' | 'STALE' | 'OFFLINE' | 'MAINTENANCE' | 'ERROR' | 'UNKNOWN';

export function deriveDeviceState(device: { status?: string | null; last_seen_at?: string | null }, staleAfterS = 120): DerivedDeviceState {
  if (device.status === 'maintenance' || device.status === 'MAINTENANCE') return 'MAINTENANCE';
  if (device.status === 'error' || device.status === 'ERROR' || device.status === 'fault') return 'ERROR';
  if (!device.last_seen_at) return 'UNKNOWN';
  const ageMs = Date.now() - new Date(device.last_seen_at).getTime();
  if (ageMs <= staleAfterS * 1000) return 'ONLINE';
  return 'STALE';
}

export function findDeviceByApiKey(apiKey: string): Promise<DeviceRow | null> {
  return dbGet(`SELECT * FROM devices WHERE api_key = $1`, [apiKey]) as Promise<DeviceRow | null>;
}

// ── Deployments (server-resolved: device → active deployment → field) ──────
export async function activeDeploymentForDevice(deviceId: string, fieldId?: string): Promise<any | null> {
  const q = fieldId
    ? `SELECT * FROM device_deployments WHERE device_id = $1 AND field_id = $2 AND status = 'active' AND removal_date IS NULL ORDER BY deployment_date DESC LIMIT 1`
    : `SELECT * FROM device_deployments WHERE device_id = $1 AND status = 'active' AND removal_date IS NULL ORDER BY deployment_date DESC LIMIT 1`;
  return (await dbGet(q, fieldId ? [deviceId, fieldId] : [deviceId])) as any | null;
}

export async function listDeploymentsForDevice(deviceId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM device_deployments WHERE device_id = $1 ORDER BY deployment_date DESC`, [deviceId]);
}

// ── Raw telemetry (preserved verbatim; canonical truth lives in observations) ─
export async function saveRawTelemetry(input: {
  messageId?: string; deviceId?: string; fieldId?: string; topic?: string;
  payload: unknown; state?: string; outcome?: unknown;
}): Promise<RawTelemetryRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO telemetry_raw (id, message_id, device_id, field_id, topic, payload, state, outcome)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.messageId || null, input.deviceId || null, input.fieldId || null,
     input.topic || null, input.payload, input.state || 'RECEIVED', input.outcome ?? null]
  );
  return (await dbGet(`SELECT * FROM telemetry_raw WHERE id = $1`, [id])) as RawTelemetryRow;
}

export async function updateRawTelemetryState(id: string, state: string, outcome?: unknown): Promise<void> {
  await dbRun(`UPDATE telemetry_raw SET state = $1, outcome = $2 WHERE id = $3`, [state, outcome ?? null, id]);
}

export async function rawTelemetryExists(deviceId: string, messageId?: string): Promise<boolean> {
  if (!messageId) return false;
  return !!(await dbGet(`SELECT 1 AS ok FROM telemetry_raw WHERE device_id = $1 AND message_id = $2`, [deviceId, messageId]));
}

export async function listRawTelemetry(deviceId: string, limit = 100): Promise<RawTelemetryRow[]> {
  return (await dbAll(`SELECT * FROM telemetry_raw WHERE device_id = $1 ORDER BY received_at DESC LIMIT ${limit}`, [deviceId])) as RawTelemetryRow[];
}

// ── Heartbeats & device events ─────────────────────────────────────────────
export async function recordHeartbeat(input: {
  deviceId: string; battery?: number | null; signalStrength?: number | null; uptimeS?: number | null;
  firmwareVersion?: string | null; payload?: Record<string, unknown>; status?: string;
}): Promise<HeartbeatRow> {
  const id = generateId();
  const now = new Date().toISOString();
  await dbRun(
    `INSERT INTO device_heartbeats (id, device_id, recorded_at, battery, signal_strength, uptime_s, firmware_version, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.deviceId, now, input.battery ?? null, input.signalStrength ?? null, input.uptimeS ?? null,
     input.firmwareVersion ?? null, input.payload || {}]
  );
  await updateDevice(input.deviceId, {
    lastSeenAt: now, status: input.status || 'active',
    battery: input.battery !== null && input.battery !== undefined ? Number(input.battery) : undefined,
  });
  return (await dbGet(`SELECT * FROM device_heartbeats WHERE id = $1`, [id])) as HeartbeatRow;
}

export async function listHeartbeats(deviceId: string, limit = 50): Promise<HeartbeatRow[]> {
  return (await dbAll(`SELECT * FROM device_heartbeats WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT ${limit}`, [deviceId])) as HeartbeatRow[];
}

export async function recordDeviceEvent(deviceId: string, type: string, data: Record<string, unknown> = {}, occurredAt?: string): Promise<DeviceEventRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO device_events (id, device_id, type, occurred_at, data) VALUES ($1,$2,$3,$4,$5)`,
    [id, deviceId, type, occurredAt || new Date().toISOString(), data]
  );
  return (await dbGet(`SELECT * FROM device_events WHERE id = $1`, [id])) as DeviceEventRow;
}

export async function listDeviceEvents(deviceId: string, limit = 50): Promise<DeviceEventRow[]> {
  return (await dbAll(`SELECT * FROM device_events WHERE device_id = $1 ORDER BY occurred_at DESC LIMIT ${limit}`, [deviceId])) as DeviceEventRow[];
}

// ── Calibrations ────────────────────────────────────────────────────────────
export type CalibrationState = 'CALIBRATED' | 'CALIBRATION_EXPIRED' | 'NOT_CALIBRATED';

export interface CalibrationStatus {
  state: CalibrationState;
  version: number | null;
  calibrated_at?: string | null;
  valid_until?: string | null;
  method?: string | null;
}

export async function listCalibrations(sensorId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM sensor_calibrations WHERE sensor_id = $1 ORDER BY version DESC`, [sensorId]);
}

export async function calibrationStatus(sensor: { id: string; calibration_version: number }): Promise<CalibrationStatus> {
  const latest = (await dbGet(
    `SELECT * FROM sensor_calibrations WHERE sensor_id = $1 ORDER BY version DESC LIMIT 1`, [sensor.id]
  )) as any | null;
  if (!latest) return { state: 'NOT_CALIBRATED', version: null };
  if (latest.valid_until && new Date(latest.valid_until).getTime() < Date.now()) {
    return { state: 'CALIBRATION_EXPIRED', version: latest.version, calibrated_at: latest.calibrated_at, valid_until: latest.valid_until, method: latest.method };
  }
  return { state: 'CALIBRATED', version: latest.version, calibrated_at: latest.calibrated_at, valid_until: latest.valid_until, method: latest.method };
}

export async function getSensorForUser(sensorId: string, userId: string): Promise<any | null> {
  return (await dbGet(
    `SELECT s.* FROM sensors s JOIN devices d ON d.id = s.device_id
     WHERE s.id = $1 AND d.user_id = $2`, [sensorId, userId]
  )) as any | null;
}

export async function updateSensor(id: string, patch: { unit?: string; minValue?: number; maxValue?: number; status?: string }): Promise<any | null> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.unit !== undefined) { params.push(patch.unit); sets.push(`unit = $${params.length}`); }
  if (patch.minValue !== undefined) { params.push(patch.minValue); sets.push(`min_value = $${params.length}`); }
  if (patch.maxValue !== undefined) { params.push(patch.maxValue); sets.push(`max_value = $${params.length}`); }
  if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
  if (sets.length === 0) return dbGet(`SELECT * FROM sensors WHERE id = $1`, [id]);
  await dbRun(`UPDATE sensors SET ${sets.join(', ')} WHERE id = $${params.length + 1}`, [...params, id]);
  return dbGet(`SELECT * FROM sensors WHERE id = $1`, [id]);
}

export async function listSensorsForDevice(deviceId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM sensors WHERE device_id = $1 ORDER BY created_at DESC`, [deviceId]);
}

export async function latestObservationForDevice(deviceId: string): Promise<ObservationRow | null> {
  return (await dbGet(`${OBS_SELECT} WHERE o.device_id = $1 ORDER BY o."timestamp" DESC LIMIT 1`, [deviceId])) as ObservationRow | null;
}

export async function listObservationsForDevice(deviceId: string, limit = 100): Promise<ObservationRow[]> {
  return (await dbAll(`${OBS_SELECT} WHERE o.device_id = $1 ORDER BY o."timestamp" DESC LIMIT ${limit}`, [deviceId])) as ObservationRow[];
}

// ── Downlink commands (whitelist enforced at route/service layer) ───────────
export async function listDeviceCommands(deviceId: string, limit = 50): Promise<CommandRow[]> {
  return (await dbAll(`SELECT * FROM commands WHERE device_id = $1 ORDER BY requested_at DESC LIMIT ${limit}`, [deviceId])) as CommandRow[];
}

export async function createCommand(input: {
  deviceId: string; fieldId?: string; userId?: string; command: string;
  params?: Record<string, unknown>; expiresAt?: string;
}): Promise<CommandRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO commands (id, device_id, field_id, user_id, command, params, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,'QUEUED',$7)`,
    [id, input.deviceId, input.fieldId || null, input.userId || null, input.command,
     input.params || {}, input.expiresAt || null]
  );
  return (await dbGet(`SELECT * FROM commands WHERE id = $1`, [id])) as CommandRow;
}

export async function updateCommand(commandId: string, patch: Partial<CommandRow>): Promise<CommandRow | null> {
  const cols: Record<string, unknown> = {
    status: patch.status, sent_at: patch.sent_at, acked_at: patch.acked_at,
    expires_at: patch.expires_at, ack_message_id: patch.ack_message_id, error: patch.error,
  };
  const sets: string[] = [];
  const params: any[] = [];
  for (const [k, v] of Object.entries(cols)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (sets.length === 0) return null;
  params.push(new Date().toISOString());
  await dbRun(`UPDATE commands SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, commandId]);
  return (await dbGet(`SELECT * FROM commands WHERE id = $1`, [commandId])) as CommandRow | null;
}

// ── Devices ─────────────────────────────────────────────────────────────────
export interface DeviceRow {
  id: string; user_id: string; farm_id?: string | null; field_id?: string | null;
  name: string; type: string; serial_number?: string | null; firmware_version?: string | null;
  hardware_version?: string | null; status: string; location?: GeoJSON.Point | null;
  last_seen_at?: string | null; battery?: number | null; created_at: string; updated_at: string;
}

const DEV_SELECT = `SELECT d.id, d.user_id, d.farm_id, d.field_id, d.name, d.type, d.serial_number,
  d.firmware_version, d.hardware_version, d.status, ${GEO.toJson('d.location', 'location')},
  d.last_seen_at, d.battery, d.created_at, d.updated_at FROM devices d`;

export async function createDevice(input: {
  userId: string; name: string; type: string; serialNumber?: string;
  farmId?: string; fieldId?: string; location?: GeoJSON.Point; firmwareVersion?: string; hardwareVersion?: string;
}): Promise<DeviceRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO devices (id, user_id, farm_id, field_id, name, type, serial_number, firmware_version, hardware_version, status, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'inactive',${GEO.fromJson('$10')})`,
    [id, input.userId, input.farmId || null, input.fieldId || null, input.name, input.type,
     input.serialNumber || null, input.firmwareVersion || null, input.hardwareVersion || null,
     input.location ? JSON.stringify(input.location) : null]
  );
  return (await dbGet(`${DEV_SELECT} WHERE d.id = $1`, [id])) as DeviceRow;
}

export async function getDevice(id: string, userId?: string): Promise<DeviceRow | null> {
  const q = userId
    ? `${DEV_SELECT} WHERE d.id = $1 AND d.user_id = $2`
    : `${DEV_SELECT} WHERE d.id = $1`;
  return (await dbGet(q, userId ? [id, userId] : [id])) as DeviceRow | null;
}

export async function listDevicesForField(fieldId: string, userId: string): Promise<DeviceRow[]> {
  return (await dbAll(`${DEV_SELECT} WHERE d.field_id = $1 AND d.user_id = $2 ORDER BY d.created_at DESC`, [fieldId, userId])) as DeviceRow[];
}

export async function listDevicesForUser(userId: string): Promise<DeviceRow[]> {
  return (await dbAll(`${DEV_SELECT} WHERE d.user_id = $1 ORDER BY d.created_at DESC`, [userId])) as DeviceRow[];
}

export async function updateDevice(id: string, patch: { status?: string; fieldId?: string | null; lastSeenAt?: string; battery?: number | null }): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
  if (patch.fieldId !== undefined) { params.push(patch.fieldId); sets.push(`field_id = $${params.length}`); }
  if (patch.lastSeenAt !== undefined) { params.push(patch.lastSeenAt); sets.push(`last_seen_at = $${params.length}`); }
  if (patch.battery !== undefined) { params.push(patch.battery); sets.push(`battery = $${params.length}`); }
  if (sets.length === 0) return;
  params.push(new Date().toISOString());
  await dbRun(`UPDATE devices SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, id]);
}

// ── Deployments ─────────────────────────────────────────────────────────────
export async function createDeployment(input: { deviceId: string; fieldId: string; deploymentDate: string; location?: GeoJSON.Point; depthMeters?: number | null }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO device_deployments (id, device_id, field_id, deployment_date, location, depth_meters)
     VALUES ($1,$2,$3,$4,${GEO.fromJson('$5')},$6)`,
    [id, input.deviceId, input.fieldId, input.deploymentDate,
     input.location ? JSON.stringify(input.location) : null, input.depthMeters ?? null]
  );
  return dbGet(`SELECT * FROM device_deployments WHERE id = $1`, [id]);
}

export async function listDeploymentsForField(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM device_deployments WHERE field_id = $1 ORDER BY deployment_date DESC`, [fieldId]);
}

// ── Sensors ─────────────────────────────────────────────────────────────────
export async function createSensor(input: { deviceId: string; sensorType: string; unit?: string; minValue?: number; maxValue?: number }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO sensors (id, device_id, sensor_type, unit, min_value, max_value)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.deviceId, input.sensorType, input.unit || null, input.minValue ?? null, input.maxValue ?? null]
  );
  return dbGet(`SELECT * FROM sensors WHERE id = $1`, [id]);
}

export async function listSensorsForField(fieldId: string, userId: string): Promise<any[]> {
  return dbAll(
    `SELECT s.* FROM sensors s JOIN devices d ON d.id = s.device_id
     WHERE d.field_id = $1 AND d.user_id = $2 ORDER BY s.created_at DESC`, [fieldId, userId]
  );
}

export async function getSensorByDeviceAndType(deviceId: string, sensorType: string): Promise<any | null> {
  return dbGet(`SELECT * FROM sensors WHERE device_id = $1 AND sensor_type = $2 LIMIT 1`, [deviceId, sensorType]);
}

export async function addCalibration(input: { sensorId: string; calibrationData: Record<string, unknown>; calibratedBy?: string; method?: string; validUntil?: string }): Promise<any> {
  const cur = (await dbGet(`SELECT COALESCE(MAX(version),0) AS v FROM sensor_calibrations WHERE sensor_id = $1`, [input.sensorId])) as any;
  const version = Number(cur?.v || 0) + 1;
  const id = generateId();
  await dbRun(
    `INSERT INTO sensor_calibrations (id, sensor_id, version, calibration_data, method, valid_until, calibrated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.sensorId, version, input.calibrationData, input.method || null,
     input.validUntil || null, input.calibratedBy || null]
  );
  await dbRun(`UPDATE sensors SET calibration_version = $1 WHERE id = $2`, [version, input.sensorId]);
  return dbGet(`SELECT * FROM sensor_calibrations WHERE id = $1`, [id]);
}

// ── Observations ────────────────────────────────────────────────────────────
export interface ObservationRow {
  id: string; user_id: string; farm_id: string; field_id: string;
  device_id?: string | null; deployment_id?: string | null; sensor_id?: string | null;
  sensor_type?: string | null; geometry?: GeoJSON.Point | null; depth_meters?: number | null;
  timestamp: string; value: number; unit: string; quality: string;
  calibration_version?: number | null; firmware_version?: string | null;
  provenance: Record<string, unknown>; ingestion_metadata: Record<string, unknown>;
  created_at: string;
}

const OBS_SELECT = `SELECT o.id, o.user_id, o.farm_id, o.field_id, o.device_id, o.deployment_id,
  o.sensor_id, o.sensor_type, ${GEO.toJson('o.geometry', 'geometry')}, o.depth_meters,
  o."timestamp", o.value, o.unit, o.quality, o.calibration_version, o.firmware_version,
  o.provenance, o.ingestion_metadata, o.created_at FROM observations o`;

export async function insertObservation(input: {
  userId: string; farmId: string; fieldId: string; deviceId?: string; deploymentId?: string;
  sensorId?: string; sensorType?: string; geometry?: GeoJSON.Point | null; depthMeters?: number | null;
  timestamp: string; value: number; unit: string; quality: string;
  calibrationVersion?: number | null; firmwareVersion?: string | null;
  provenance?: Record<string, unknown>; ingestionMetadata?: Record<string, unknown>;
}): Promise<ObservationRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO observations (id, user_id, farm_id, field_id, device_id, deployment_id, sensor_id,
      sensor_type, geometry, depth_meters, "timestamp", value, unit, quality, calibration_version,
      firmware_version, provenance, ingestion_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,${GEO.fromJson('$9')},$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, input.userId, input.farmId, input.fieldId, input.deviceId || null, input.deploymentId || null,
     input.sensorId || null, input.sensorType || null, input.geometry ? JSON.stringify(input.geometry) : null,
     input.depthMeters ?? null, input.timestamp, input.value, input.unit, input.quality,
     input.calibrationVersion ?? null, input.firmwareVersion || null, input.provenance || {}, input.ingestionMetadata || {}]
  );
  return (await dbGet(`${OBS_SELECT} WHERE o.id = $1`, [id])) as ObservationRow;
}

export async function observationExists(deviceId: string, timestamp: string, value: number): Promise<boolean> {
  return !!(await dbGet(`SELECT 1 AS ok FROM observations WHERE device_id = $1 AND "timestamp" = $2 AND value = $3`, [deviceId, timestamp, value]));
}

export async function listObservations(input: { fieldId: string; userId: string; sensorType?: string; limit?: number; since?: string }): Promise<ObservationRow[]> {
  const where = ['o.field_id = $1', 'o.user_id = $2'];
  const params: any[] = [input.fieldId, input.userId];
  if (input.sensorType) { where.push(`o.sensor_type = $${params.length + 1}`); params.push(input.sensorType); }
  if (input.since) { where.push(`o."timestamp" >= $${params.length + 1}`); params.push(input.since); }
  const limit = input.limit || 500;
  return (await dbAll(`${OBS_SELECT} WHERE ${where.join(' AND ')} ORDER BY o."timestamp" DESC LIMIT ${limit}`, params)) as ObservationRow[];
}

export async function latestObservation(fieldId: string, sensorType?: string): Promise<ObservationRow | null> {
  const q = sensorType
    ? `${OBS_SELECT} WHERE o.field_id = $1 AND o.sensor_type = $2 ORDER BY o."timestamp" DESC LIMIT 1`
    : `${OBS_SELECT} WHERE o.field_id = $1 ORDER BY o."timestamp" DESC LIMIT 1`;
  return (await dbGet(q, sensorType ? [fieldId, sensorType] : [fieldId])) as ObservationRow | null;
}

export async function latestObservationsByType(fieldId: string, limitTypes = 10): Promise<any[]> {
  return dbAll(
    `SELECT * FROM (
       SELECT o.*, ROW_NUMBER() OVER (PARTITION BY o.sensor_type ORDER BY o."timestamp" DESC) AS rn
       FROM observations o WHERE o.field_id = $1
     ) t WHERE t.rn = 1 LIMIT ${limitTypes}`, [fieldId]
  );
}
