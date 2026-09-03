/**
 * Voice-device API (ESP32-based edge voice unit).
 *
 * The voice device is a standard AGRIFUR device of type 'voice_assistant':
 * same authorization (per-device key), same field ownership rules. The ESP32
 * runs audio/wake-word/offline-cache logic; the LLM/RAG/tools always run on
 * the backend. This API exposes the offline cache snapshot so the edge can
 * answer "last recorded …" questions truthfully without connectivity.
 */
import { Router, Response, NextFunction, Request } from 'express';
import crypto from 'crypto';
import { authenticate, AuthRequest } from '../middleware/auth';
import {
  createDevice, getDevice, findDeviceByApiKey, recordHeartbeat, recordDeviceEvent,
  deriveDeviceState, listObservations, listDeviceCommands,
} from '../data/sensors';
import { getField } from '../data/fields';
import { emitEvent } from '../services/events';
import type { DeviceRow } from '../data/sensors';

const router = Router();

interface VoiceDeviceRequest extends Request { vdevice?: DeviceRow; }

async function deviceKeyAuth(req: VoiceDeviceRequest, res: Response, next: NextFunction) {
  const key = req.headers['x-device-key'] as string | undefined;
  if (!key) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'x-device-key header is required' } });
  const row = await findDeviceByApiKey(key);
  if (!row || row.type !== 'voice_assistant') {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Unknown voice-device key' } });
  }
  req.vdevice = row;
  next();
}

router.post('/register', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, field_id, firmware_version } = req.body || {};
    if (field_id) {
      const field = await getField(field_id, req.user!.id);
      if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found or not owned by user' } });
    }
    const apiKey = crypto.randomBytes(24).toString('hex');
    const device = await createDevice({
      userId: req.user!.id, name: name || 'Edge Voice Assistant', type: 'voice_assistant',
      fieldId: field_id || undefined, firmwareVersion: firmware_version,
    });
    const { dbRun } = await import('../data/db');
    await dbRun(`UPDATE devices SET api_key = $1 WHERE id = $2`, [apiKey, device.id]);
    await emitEvent('VOICE_DEVICE_REGISTERED', { device_id: device.id, field_id: field_id || null }, { fieldId: field_id || undefined, userId: req.user!.id }).catch(() => {});
    res.status(201).json({
      success: true,
      data: {
        device_id: device.id, device_key: apiKey,
        type: 'voice_assistant',
        note: 'Store the key on the voice device (never in the LLM path). Voice answers always come from the backend tools; this key only authenticates the device.',
      },
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:deviceId/status', deviceKeyAuth, async (req: VoiceDeviceRequest, res: Response) => {
  if (req.vdevice!.id !== req.params.deviceId) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Key does not match device' } });
  const state = deriveDeviceState(req.vdevice!);
  res.json({
    success: true,
    data: {
      device_id: req.vdevice!.id, field_id: req.vdevice!.field_id,
      derived_state: state, battery: req.vdevice!.battery, last_seen_at: req.vdevice!.last_seen_at,
      online_mode: state === 'ONLINE' ? 'AVAILABLE' : 'OFFLINE',
      note: 'While OFFLINE the device answers only from the last verified cache with explicit timestamps (offline voice mode).',
    },
  });
});

router.post('/:deviceId/heartbeat', deviceKeyAuth, async (req: VoiceDeviceRequest, res: Response) => {
  if (req.vdevice!.id !== req.params.deviceId) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Key does not match device' } });
  const { battery, firmware_version, status } = req.body || {};
  const hb = await recordHeartbeat({
    deviceId: req.vdevice!.id,
    battery: battery != null ? Number(battery) : null,
    firmwareVersion: firmware_version || null,
    payload: req.body || {}, status: status || 'active',
  });
  res.json({ success: true, data: { device_id: req.vdevice!.id, last_seen_at: hb.recorded_at, derived_state: deriveDeviceState({ ...req.vdevice!, last_seen_at: hb.recorded_at }) } });
});

/**
 * Edge sync — refresh the offline cache. Returns the latest verified
 * observation per sensor type (with real timestamps) plus pending commands so
 * the offline voice layer can answer "last recorded …" truthfully.
 */
router.post('/:deviceId/sync', deviceKeyAuth, async (req: VoiceDeviceRequest, res: Response) => {
  if (req.vdevice!.id !== req.params.deviceId) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Key does not match device' } });
  const fieldId = req.vdevice!.field_id;
  const hb = await recordHeartbeat({ deviceId: req.vdevice!.id, payload: req.body || {} });
  const rows = fieldId ? await listObservations({ fieldId, userId: req.vdevice!.user_id, limit: 500 }) : [];
  const latestByType = new Map<string, any>();
  for (const r of rows) if (!latestByType.has(r.sensor_type || '?')) latestByType.set(r.sensor_type || '?', r);
  const cache = Array.from(latestByType.values()).map((o) => ({
    sensor_type: o.sensor_type, value: o.value, unit: o.unit, quality: o.quality,
    observed_at: o.timestamp, // real measurement time — offline answers must quote this
    ingested_at: o.created_at,
  }));
  const pending = fieldId ? (await listDeviceCommands(req.vdevice!.id, 20)).filter((c) => c.status === 'QUEUED') : [];
  await recordDeviceEvent(req.vdevice!.id, 'VOICE_SYNC', { cached: cache.length, pending: pending.length }).catch(() => {});
  res.json({
    success: true,
    data: {
      device_id: req.vdevice!.id,
      field_id: fieldId,
      synced_at: new Date().toISOString(),
      cache,
      cache_note: 'Offline answers must say “last recorded <value> at <observed_at>” — never “current”, unless the reading satisfies configured freshness criteria.',
      pending_commands: pending.map((c) => ({ command_id: c.id, command: c.command, params: c.params })),
    },
  });
});

export default router;
