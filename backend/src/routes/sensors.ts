/**
 * Sensor & IoT API (device registry, transport, offline sync, downlink).
 *
 * Device auth  → x-device-key header (issued once at register; shown only once).
 * User auth    → Bearer JWT. Ownership + field isolation always server-side.
 *
 *   POST   /api/devices/register                 (user)   register + api key
 *   GET    /api/devices                          (user)   list my devices
 *   GET    /api/devices/:id                      (user)   device detail
 *   PATCH  /api/devices/:id                      (user)   metadata/maintenance
 *   GET    /api/devices/:id/status               (user)   derived device state
 *   POST   /api/devices/:id/heartbeat            (device)
 *   POST   /api/devices/:id/telemetry            (device)
 *   POST   /api/devices/:id/sync                 (device) offline buffer replay
 *   GET    /api/devices/:id/commands             (user)
 *   POST   /api/devices/:id/commands             (user)   whitelisted downlink
 *   POST   /api/devices/:id/acks                 (device) command acknowledgements
 *   POST   /api/devices/:id/events               (device)
 *   GET    /api/sensors/:id/status|calibrations  (user)
 *   POST   /api/sensors/:id/calibrations         (user)
 *   PATCH  /api/sensors/:id                      (user)
 *   GET    /api/fields/:id/devices|sensors|observations[/latest|/timeseries]
 *   POST   /api/fields/:id/devices/:deviceId/deploy
 *   GET    /api/fields/:id/hardware-health
 */
import { Router, Response, Request, NextFunction } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import {
  createDevice, getDevice, listDevicesForField, updateDevice, createSensor,
  createDeployment, listSensorsForField, getSensorByDeviceAndType, addCalibration,
  listObservations, latestObservationsByType, listDeploymentsForField,
  findDeviceByApiKey, deriveDeviceState, activeDeploymentForDevice,
  listSensorsForDevice, listCalibrations, calibrationStatus,
  listHeartbeats, listDeviceEvents, latestObservationForDevice, listObservationsForDevice,
  listDeviceCommands, createCommand, updateCommand, getSensorForUser, updateSensor,
  listDevicesForUser, recordHeartbeat, recordDeviceEvent, listRawTelemetry,
} from '../data/sensors';
import { ingestTelemetryBatch } from '../services/sensors/ingest';
import { publishCommand, mqttStatus } from '../services/sensors/mqtt-client';
import { getField } from '../data/fields';
import { emitEvent } from '../services/events';
import type { DeviceRow } from '../data/sensors';

// ── Command safety ──────────────────────────────────────────────────────────
const SAFE_COMMANDS: Record<string, string[]> = {
  request_sensor_reading: [],
  request_device_status: [],
  sync_device: [],
  sync_time: [],
  firmware_update_check: [],
  set_sampling_interval: ['seconds'], // range-checked below
};
const ACTUATOR_COMMANDS = new Set(['restart_device', 'start_irrigation', 'stop_irrigation', 'open_valve', 'close_valve']);
const ACTUATOR_FLAG = process.env.AGRIFUR2_ENABLE_ACTUATORS === 'true';

function validateCommandRequest(cmd: string, params: Record<string, any>): string | null {
  if (ACTUATOR_COMMANDS.has(cmd)) {
    if (!ACTUATOR_FLAG) return `Actuator command "${cmd}" is disabled. Physical actuation requires AGRIFUR2_ENABLE_ACTUATORS=true plus an explicit authorization policy — it is never exposed to the AI.`;
    return null;
  }
  if (!(cmd in SAFE_COMMANDS)) return `Unknown command "${cmd}". Allowed: ${Object.keys(SAFE_COMMANDS).join(', ')}`;
  if (cmd === 'set_sampling_interval') {
    const s = Number(params?.seconds);
    if (!Number.isFinite(s) || s < 5 || s > 86400) return 'set_sampling_interval requires seconds in [5, 86400].';
  }
  return null;
}

interface DeviceRequest extends Request {
  device?: DeviceRow;
}

async function deviceKeyAuth(req: DeviceRequest, res: Response, next: NextFunction) {
  const key = req.headers['x-device-key'] as string | undefined;
  if (!key) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'x-device-key header is required' } });
  const row = await findDeviceByApiKey(key);
  if (!row) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unknown device key' } });
  req.device = row;
  next();
}

function deny(res: Response, code: string, message: string, status = 403) {
  return res.status(status).json({ success: false, error: { code, message } });
}

export const devicesRouter = Router();

// ── Registration ────────────────────────────────────────────────────────────
devicesRouter.post('/register', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, serial_number, field_id, firmware_version, hardware_version, location } = req.body || {};
    if (!name || !type) return deny(res, 'VALIDATION', 'name and type are required', 400);
    if (field_id) {
      const field = await getField(field_id, req.user!.id);
      if (!field) return deny(res, 'NOT_FOUND', 'Field not found or not owned by user', 404);
    }
    const apiKey = crypto.randomBytes(24).toString('hex');
    const device = await createDevice({
      userId: req.user!.id, name, type, serialNumber: serial_number,
      fieldId: field_id || undefined, firmwareVersion: firmware_version, hardwareVersion: hardware_version,
      location: location?.type === 'Point' ? location : undefined,
    });
    const { dbRun } = await import('../data/db');
    await dbRun(`UPDATE devices SET api_key = $1 WHERE id = $2`, [apiKey, device.id]);
    if (field_id) await createDeployment({ deviceId: device.id, fieldId: field_id, deploymentDate: new Date().toISOString().slice(0, 10) }).catch(() => {});
    await emitEvent('SENSOR_CONNECTED', { device_id: device.id, field_id: field_id || null }, { fieldId: field_id || undefined, userId: req.user!.id }).catch(() => {});
    res.status(201).json({
      success: true,
      data: {
        device_id: device.id,
        device_key: apiKey,
        note: 'Send x-device-key with heartbeat, telemetry and sync requests. Store the key on the device — it is shown only once.',
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ── Device registry (user auth) ─────────────────────────────────────────────
devicesRouter.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const devices = await listDevicesForUser(req.user!.id);
  res.json({
    success: true,
    data: devices.map((d) => ({
      ...d, derived_state: deriveDeviceState(d),
      api_key: undefined, // never re-expose the device key
    })),
    total: devices.length,
  });
});

devicesRouter.get('/:deviceId', authenticate, async (req: AuthRequest, res: Response) => {
  const device = await getDevice(req.params.deviceId, req.user!.id);
  if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
  const [deployment, sensors, heartbeats, events, latest, raw] = await Promise.all([
    activeDeploymentForDevice(device.id),
    listSensorsForDevice(device.id),
    listHeartbeats(device.id, 1),
    listDeviceEvents(device.id, 10),
    latestObservationForDevice(device.id),
    listRawTelemetry(device.id, 5),
  ]);
  const sensorsDetailed = await Promise.all(sensors.map(async (s) => ({ ...s, calibration: await calibrationStatus(s) })));
  res.json({
    success: true,
    data: {
      id: device.id, name: device.name, type: device.type, field_id: device.field_id,
      firmware_version: device.firmware_version, hardware_version: device.hardware_version,
      serial_number: device.serial_number, status: device.status,
      derived_state: deriveDeviceState(device),
      battery: device.battery, last_seen_at: device.last_seen_at,
      created_at: device.created_at,
      deployment, sensors: sensorsDetailed, latest_observation: latest,
      recent_heartbeat: heartbeats[0] || null, recent_events: events, recent_raw_telemetry: raw,
    },
  });
});

devicesRouter.patch('/:deviceId', authenticate, async (req: AuthRequest, res: Response) => {
  const device = await getDevice(req.params.deviceId, req.user!.id);
  if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
  const { name, firmware_version, hardware_version, serial_number, status } = req.body || {};
  const allowedStatus = ['active', 'maintenance', 'error', 'retired'];
  if (status && !allowedStatus.includes(String(status).toLowerCase())) {
    return deny(res, 'VALIDATION', `status must be one of ${allowedStatus.join(', ')}`, 400);
  }
  const sets: string[] = [];
  const params: any[] = [];
  const col = { name, firmware_version, hardware_version, serial_number };
  for (const [k, v] of Object.entries(col)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (status) { params.push(String(status).toLowerCase()); sets.push(`status = $${params.length}`); }
  if (sets.length > 0) {
    params.push(new Date().toISOString());
    const { dbRun } = await import('../data/db');
    await dbRun(`UPDATE devices SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, device.id]);
  }
  if (status) {
    await recordDeviceEvent(device.id, status.toUpperCase(), { changed_by: req.user!.email }).catch(() => {});
  }
  res.json({ success: true, data: { ...(await getDevice(device.id, req.user!.id)), api_key: undefined } });
});

devicesRouter.get('/:deviceId/status', authenticate, async (req: AuthRequest, res: Response) => {
  const device = await getDevice(req.params.deviceId, req.user!.id);
  if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
  const heartbeat = (await listHeartbeats(device.id, 1))[0] || null;
  const latest = await latestObservationForDevice(device.id);
  res.json({
    success: true,
    data: {
      device_id: device.id, name: device.name, type: device.type,
      derived_state: deriveDeviceState(device),
      status: device.status, battery: device.battery, last_seen_at: device.last_seen_at,
      stale_after_s: 120,
      latest_heartbeat: heartbeat,
      latest_observation: latest ? { sensor_type: latest.sensor_type, value: latest.value, unit: latest.unit, quality: latest.quality, timestamp: latest.timestamp } : null,
      note: 'derived_state is computed from real device activity (last_seen_at vs stale_after_s) — it is never hardcoded.',
    },
  });
});

devicesRouter.get('/:deviceId/commands', authenticate, async (req: AuthRequest, res: Response) => {
  const device = await getDevice(req.params.deviceId, req.user!.id);
  if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
  const commands = await listDeviceCommands(req.params.deviceId, 50);
  res.json({ success: true, data: commands, total: commands.length });
});

devicesRouter.post('/:deviceId/commands', authenticate, async (req: AuthRequest, res: Response) => {
  const device = await getDevice(req.params.deviceId, req.user!.id);
  if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
  const { command, params } = req.body || {};
  if (!command) return deny(res, 'VALIDATION', 'command is required', 400);
  const problem = validateCommandRequest(String(command), params || {});
  if (problem) return deny(res, 'COMMAND_REJECTED', problem);
  const row = await createCommand({
    deviceId: device.id, fieldId: device.field_id || undefined, userId: req.user!.id,
    command: String(command), params: params || {},
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });
  await recordDeviceEvent(device.id, 'COMMAND_REQUESTED', { command_id: row.id, command: row.command, by: req.user!.email }).catch(() => {});
  const sent = publishCommand(device.id, { id: row.id, command: row.command, params: row.params });
  if (sent) {
    await updateCommand(row.id, { status: 'SENT', sent_at: new Date().toISOString() });
  }
  await emitEvent('COMMAND_REQUESTED', { command_id: row.id, command: row.command, sent, device_id: device.id }, { fieldId: device.field_id || undefined, userId: req.user!.id }).catch(() => {});
  res.status(201).json({
    success: true,
    data: { ...row, sent },
    message: sent
      ? `Command ${row.command} published to ${mqttStatus() === 'CONNECTED' ? 'MQTT' : 'device sync (queued)'}.`
      : `Command queued (${mqttStatus()}). It will be delivered via MQTT when the broker is reachable or on the device's next sync.`,
  });
});

// ── Device transport (device key) ───────────────────────────────────────────
devicesRouter.post('/:deviceId/heartbeat', deviceKeyAuth, async (req: DeviceRequest, res: Response) => {
  try {
    if (req.device!.id !== req.params.deviceId) return deny(res, 'FORBIDDEN', 'Device key does not match device id');
    const { status: st, battery, signal_strength, rssi, uptime_s, firmware_version } = req.body || {};
    const heartbeat = await recordHeartbeat({
      deviceId: req.device!.id,
      battery: battery != null ? Number(battery) : null,
      signalStrength: signal_strength != null ? Number(signal_strength) : (rssi != null ? Number(rssi) : null),
      uptimeS: uptime_s != null ? Number(uptime_s) : null,
      firmwareVersion: firmware_version || null,
      payload: req.body || {},
      status: st ? String(st).toLowerCase() : 'active',
    });
    await recordDeviceEvent(req.device!.id, 'HEARTBEAT', { battery: battery ?? null, signal: signal_strength ?? rssi ?? null }).catch(() => {});
    res.json({
      success: true,
      data: {
        device_id: req.device!.id, status: st || 'active',
        last_seen_at: heartbeat.recorded_at,
        derived_state: deriveDeviceState({ ...req.device, last_seen_at: heartbeat.recorded_at, status: st ? String(st).toLowerCase() : 'active' }),
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

devicesRouter.post('/:deviceId/telemetry', deviceKeyAuth, async (req: DeviceRequest, res: Response) => {
  try {
    if (req.device!.id !== req.params.deviceId) return deny(res, 'FORBIDDEN', 'Device key does not match device id');
    const payload = req.body;
    const messages = Array.isArray(payload) ? payload : [payload];
    const outcome = await ingestTelemetryBatch({ device: req.device!, messages, transport: 'https' });
    const valid = outcome.results.filter((r) => r.state === 'VALIDATED' || r.state === 'SUSPECT');
    res.json({
      success: true,
      data: {
        stored: outcome.stored, rejected: outcome.rejected,
        device_state: outcome.deviceState,
        observations: valid.map((o) => ({ id: o.observationId, sensor_type: o.sensorType, value: o.value, unit: o.unit, quality: o.state, timestamp: o.timestamp })),
        results: outcome.results,
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

/** Offline edge sync: replay a buffered batch (idempotent) + deliver commands. */
devicesRouter.post('/:deviceId/sync', deviceKeyAuth, async (req: DeviceRequest, res: Response) => {
  try {
    if (req.device!.id !== req.params.deviceId) return deny(res, 'FORBIDDEN', 'Device key does not match device id');
    const payload = req.body;
    const messages = (payload && Array.isArray(payload.messages)) ? payload.messages : (Array.isArray(payload) ? payload : []);
    const outcome = await ingestTelemetryBatch({ device: req.device!, messages, transport: 'offline-sync' });
    // piggyback pending commands (offline command delivery)
    const pending = (await listDeviceCommands(req.device!.id, 20)).filter((c) => c.status === 'QUEUED');
    for (const c of pending) {
      if (publishCommand(req.device!.id, { id: c.id, command: c.command, params: c.params })) {
        await updateCommand(c.id, { status: 'SENT', sent_at: new Date().toISOString() });
      }
    }
    res.json({
      success: true,
      data: {
        stored: outcome.stored, rejected: outcome.rejected,
        duplicates: outcome.results.filter((r) => r.state === 'DUPLICATE').length,
        results: outcome.results, device_state: outcome.deviceState,
        pending_commands: pending.map((c) => ({ command_id: c.id, command: c.command, params: c.params })),
      },
      message: 'Sync is idempotent: messages already ingested (same message id) are reported DUPLICATE and never re-inserted.',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

devicesRouter.post('/:deviceId/acks', deviceKeyAuth, async (req: DeviceRequest, res: Response) => {
  try {
    if (req.device!.id !== req.params.deviceId) return deny(res, 'FORBIDDEN', 'Device key does not match device id');
    const { command_id, status: st, error } = req.body || {};
    if (!command_id) return deny(res, 'VALIDATION', 'command_id is required', 400);
    const row = await updateCommand(command_id, {
      status: st === 'FAILED' ? 'FAILED' : 'ACKED',
      acked_at: new Date().toISOString(),
      ack_message_id: req.body.message_id || null,
      error: error || null,
    });
    if (!row) return deny(res, 'NOT_FOUND', 'Command not found', 404);
    await recordDeviceEvent(req.device!.id, 'COMMAND_' + row.status, { command_id: row.id, command: row.command }).catch(() => {});
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

devicesRouter.post('/:deviceId/events', deviceKeyAuth, async (req: DeviceRequest, res: Response) => {
  try {
    if (req.device!.id !== req.params.deviceId) return deny(res, 'FORBIDDEN', 'Device key does not match device id');
    const { type, occurred_at, data } = req.body || {};
    if (!type) return deny(res, 'VALIDATION', 'type is required', 400);
    const row = await recordDeviceEvent(req.device!.id, String(type), data || {}, occurred_at || undefined);
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

// ── Sensor registry (user auth, ownership checked) ─────────────────────────
export const sensorsRouter = Router();

sensorsRouter.patch('/:sensorId', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const sensor = await getSensorForUser(req.params.sensorId, req.user!.id);
    if (!sensor) return deny(res, 'NOT_FOUND', 'Sensor not found', 404);
    const { unit, min_value, max_value, status } = req.body || {};
    const updated = await updateSensor(sensor.id, {
      unit, minValue: min_value != null ? Number(min_value) : undefined,
      maxValue: max_value != null ? Number(max_value) : undefined, status,
    });
    res.json({ success: true, data: updated });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

sensorsRouter.get('/:sensorId/calibrations', authenticate, async (req: AuthRequest, res: Response) => {
  const sensor = await getSensorForUser(req.params.sensorId, req.user!.id);
  if (!sensor) return deny(res, 'NOT_FOUND', 'Sensor not found', 404);
  const [calibrations, calStatus, device] = await Promise.all([
    listCalibrations(sensor.id), calibrationStatus(sensor), getDevice(sensor.device_id, req.user!.id),
  ]);
  const latest = device ? await latestObservationForDevice(device.id) : null;
  res.json({ success: true, data: { sensor: { ...sensor }, calibration_state: calStatus, calibrations, latest_observation: latest } });
});

sensorsRouter.post('/:sensorId/calibrations', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const sensor = await getSensorForUser(req.params.sensorId, req.user!.id);
    if (!sensor) return deny(res, 'NOT_FOUND', 'Sensor not found', 404);
    const { calibration_data, method, valid_until, calibrated_by } = req.body || {};
    if (!calibration_data || typeof calibration_data !== 'object') {
      return deny(res, 'VALIDATION', 'calibration_data object is required (offset/scale etc.)', 400);
    }
    const cal = await addCalibration({
      sensorId: sensor.id, calibrationData: calibration_data,
      calibratedBy: calibrated_by || req.user!.email, method, validUntil: valid_until,
    });
    res.status(201).json({ success: true, data: cal });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

sensorsRouter.get('/:sensorId/status', authenticate, async (req: AuthRequest, res: Response) => {
  const sensor = await getSensorForUser(req.params.sensorId, req.user!.id);
  if (!sensor) return deny(res, 'NOT_FOUND', 'Sensor not found', 404);
  const calStatus = await calibrationStatus(sensor);
  const device = await getDevice(sensor.device_id, req.user!.id);
  res.json({
    success: true,
    data: {
      sensor: { ...sensor }, calibration: calStatus,
      device_state: device ? deriveDeviceState(device) : 'UNKNOWN',
      note: 'Calibration state is CALIBRATED / CALIBRATION_EXPIRED / NOT_CALIBRATED from actual calibration records; trust scores are NOT_ASSESSED unless genuinely computed.',
    },
  });
});

// ── Field-scoped endpoints (server-side field isolation) ───────────────────
export const fieldSensorsRouter = Router({ mergeParams: true });

// authenticate MUST run before field isolation (ownership check needs req.user)
fieldSensorsRouter.use('/:fieldId/devices', authenticate, fieldIsolation);
fieldSensorsRouter.use('/:fieldId/sensors', authenticate, fieldIsolation);
fieldSensorsRouter.use('/:fieldId/observations', authenticate, fieldIsolation);
fieldSensorsRouter.use('/:fieldId/hardware-health', authenticate, fieldIsolation);

fieldSensorsRouter.get('/:fieldId/devices', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  const [devices, deployments] = await Promise.all([
    listDevicesForField(req.fieldContext!.fieldId, req.user!.id),
    listDeploymentsForField(req.fieldContext!.fieldId),
  ]);
  res.json({
    success: true,
    data: {
      devices: devices.map((d) => ({ ...d, api_key: undefined, derived_state: deriveDeviceState(d) })),
      deployments,
    },
  });
});

fieldSensorsRouter.post('/:fieldId/devices/:deviceId/deploy', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const device = await getDevice(req.params.deviceId, req.user!.id);
    if (!device) return deny(res, 'NOT_FOUND', 'Device not found', 404);
    const { location, depth_meters } = req.body || {};
    const deployment = await createDeployment({
      deviceId: device.id, fieldId: req.fieldContext!.fieldId,
      deploymentDate: new Date().toISOString().slice(0, 10),
      location: location?.type === 'Point' ? location : undefined,
      depthMeters: depth_meters != null ? Number(depth_meters) : null,
    });
    await updateDevice(device.id, { fieldId: req.fieldContext!.fieldId, status: 'active' });
    res.status(201).json({ success: true, data: deployment });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

fieldSensorsRouter.get('/:fieldId/sensors', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  const sensors = await listSensorsForField(req.fieldContext!.fieldId, req.user!.id);
  const detailed = await Promise.all(sensors.map(async (s) => ({ ...s, calibration: await calibrationStatus(s) })));
  res.json({ success: true, data: detailed, total: detailed.length });
});

fieldSensorsRouter.post('/:fieldId/sensors', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { device_id, sensor_type, unit, min_value, max_value } = req.body || {};
    if (!device_id || !sensor_type) return deny(res, 'VALIDATION', 'device_id and sensor_type are required', 400);
    const device = await getDevice(device_id, req.user!.id);
    if (!device || device.field_id !== req.fieldContext!.fieldId) return deny(res, 'NOT_FOUND', 'Device not found in this field', 404);
    const sensor = await createSensor({ deviceId: device_id, sensorType: sensor_type, unit, minValue: min_value, maxValue: max_value });
    res.status(201).json({ success: true, data: sensor });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

fieldSensorsRouter.get('/:fieldId/observations', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  const { sensor_type, limit, since } = req.query;
  const rows = await listObservations({
    fieldId: req.fieldContext!.fieldId, userId: req.user!.id,
    sensorType: typeof sensor_type === 'string' ? sensor_type : undefined,
    limit: typeof limit === 'string' ? Math.min(Number(limit) || 500, 2000) : 500,
    since: typeof since === 'string' ? since : undefined,
  });
  res.json({ success: true, data: rows, total: rows.length });
});

fieldSensorsRouter.get('/:fieldId/observations/latest', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await latestObservationsByType(req.fieldContext!.fieldId, 30);
  res.json({ success: true, data: rows });
});

fieldSensorsRouter.get('/:fieldId/observations/timeseries', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  const latest = await latestObservationsByType(req.fieldContext!.fieldId, 30);
  res.json({ success: true, data: latest });
});

/** Aggregated hardware health for a field — derived from real activity. */
fieldSensorsRouter.get('/:fieldId/hardware-health', authenticate, async (req: FieldIsolatedRequest, res: Response) => {
  if (!req.fieldContext) return deny(res, 'FORBIDDEN', 'Field context required', 403);
  const fieldId = req.fieldContext.fieldId;
  const [devices, deployments] = await Promise.all([
    listDevicesForField(fieldId, req.user!.id),
    listDeploymentsForField(fieldId),
  ]);
  const latest = await latestObservationsByType(fieldId, 30);
  const deployed = new Set(deployments.map((d) => d.device_id));
  const now = Date.now();
  const summary = devices.map((d) => {
    const state = deriveDeviceState(d);
    const last = latest.find((o) => o.device_id === d.id);
    return {
      device_id: d.id, name: d.name, type: d.type,
      deployed: deployed.has(d.id), derived_state: state,
      battery: d.battery ?? null, last_seen_at: d.last_seen_at,
      latest_observation: last ? { sensor_type: last.sensor_type, value: last.value, unit: last.unit, quality: last.quality, timestamp: last.timestamp } : null,
      observation_age_s: last ? Math.round((now - new Date(last.timestamp).getTime()) / 1000) : null,
    };
  });
  const counts: Record<string, number> = {};
  for (const d of summary) counts[d.derived_state] = (counts[d.derived_state] || 0) + 1;
  res.json({
    success: true,
    data: {
      field_id: fieldId,
      device_count: devices.length, deployed_count: deployed.size,
      state_counts: counts,
      devices: summary,
      note: 'Every state is derived from real heartbeats/telemetry (last_seen_at vs 120 s staleness window). No device is ever shown ONLINE without activity.',
    },
  });
});
