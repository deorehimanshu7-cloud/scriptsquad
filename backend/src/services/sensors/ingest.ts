/**
 * Shared telemetry pipeline — HTTPS, MQTT and offline-sync all funnel here.
 *
 * Contract (versioned, tolerant of physically absent fields):
 *   { schemaVersion?, messageId?, sequence?, timestamp?, device?,
 *     measurements?: [{ sensorId?, type, value, unit?, depthCm? }] }
 * Legacy single-reading payloads are accepted: { sensor_type, value, unit, ... }.
 *
 * Guarantees:
 *   - raw payloads are preserved verbatim in telemetry_raw (RECEIVED → state)
 *   - replays are idempotent: dedupe on (device_id, message_id)
 *   - a valid physical reading persists as an observation AND as OBSERVED
 *     evidence (source PHYSICAL_HARDWARE) so anomaly/contradiction engines and
 *     the World Model see the hardware layer
 *   - deployment is resolved server-side (device → active deployment → field)
 *   - nothing is ever fabricated: rejected/SUSPECT payloads never become
 *     observations
 */
import { createHash } from 'crypto';
import {
  getDevice, getSensorByDeviceAndType, createSensor, insertObservation,
  rawTelemetryExists, saveRawTelemetry, updateRawTelemetryState,
  activeDeploymentForDevice, recordDeviceEvent, updateDevice, deriveDeviceState,
} from '../../data/sensors';
import { insertEvidence } from '../../data/evidence';
import { getFieldFarm } from '../../data/fields';
import { emitEvent } from '../events';
import { validateReading } from './mqtt-ingestion';
import type { DeviceRow } from '../../data/sensors';

export type MessageState = 'RECEIVED' | 'VALIDATED' | 'SUSPECT' | 'REJECTED' | 'DUPLICATE';

export interface MessageResult {
  messageId: string;
  state: MessageState;
  reason?: string;
  observationId?: string | null;
  sensorType?: string;
  value?: number;
  unit?: string;
  timestamp?: string;
}

export interface IngestBatchResult {
  deviceState: string;
  results: MessageResult[];
  stored: number;
  rejected: number;
}

/** Deterministic id for payloads without a messageId (retry-safe replay). */
export function stableMessageId(deviceId: string, m: { sensor_type?: string; timestamp?: string; value?: unknown }): string {
  const raw = `${deviceId}|${m.sensor_type || '?'}|${m.timestamp || ''}|${m.value}`;
  return `m-${createHash('sha1').update(raw).digest('hex').slice(0, 24)}`;
}

function normalizeTimestamp(ts?: string): string | null {
  if (!ts) return new Date().toISOString();
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Ingest a batch of readings from one authenticated device.
 * transport: 'https' | 'mqtt' | 'offline-sync' (sync marks the replay path).
 */
export async function ingestTelemetryBatch(input: {
  device: DeviceRow;
  messages: any[];
  transport?: 'https' | 'mqtt' | 'offline-sync';
  topic?: string;
}): Promise<IngestBatchResult> {
  const { device, messages, transport = 'https', topic } = input;
  const results: MessageResult[] = [];
  let stored = 0;
  let rejected = 0;

  if (!device.field_id) {
    await recordDeviceEvent(device.id, 'TELEMETRY_REJECTED', { reason: 'NOT_DEPLOYED', count: messages.length }).catch(() => {});
    return {
      deviceState: deriveDeviceState(device),
      results: messages.map((m) => ({ messageId: String(m.message_id || m.messageId || '?'), state: 'REJECTED', reason: 'NOT_DEPLOYED' })),
      stored: 0, rejected: messages.length,
    };
  }

  const fieldId = device.field_id;
  const deployment = await activeDeploymentForDevice(device.id, fieldId);
  const farm = await getFieldFarm(fieldId);
  if (!farm) {
    await recordDeviceEvent(device.id, 'TELEMETRY_REJECTED', { reason: 'UNKNOWN_FIELD', field_id: fieldId }).catch(() => {});
    return {
      deviceState: deriveDeviceState(device),
      results: messages.map((m: any) => ({ messageId: String(m?.message_id || '?'), state: 'REJECTED' as const, reason: 'UNKNOWN_FIELD' })),
      stored: 0, rejected: messages.length,
    };
  }
  const farmId = farm.farm_id;

  for (const raw of messages) {
    const list = Array.isArray(raw?.measurements) && raw.measurements.length > 0 ? raw.measurements : [raw];
    const deviceMeta = raw?.device && typeof raw.device === 'object' ? raw.device : {};
    const msgIdRaw = String(raw?.message_id || raw?.messageId || '');
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const sensorType = m.sensor_type || m.type;
      const value = Number(m.value);
      const messageId = msgIdRaw || stableMessageId(device.id, { sensor_type: sensorType, timestamp: m.timestamp, value });
      const makeResult = (state: MessageState, reason?: string, extra: Partial<MessageResult> = {}): MessageResult => {
        if (state === 'VALIDATED' || state === 'SUSPECT') stored += 1;
        if (state === 'REJECTED') rejected += 1;
        return { messageId, state, reason, sensorType, ...extra };
      };

      // idempotent replay protection first (offline sync, MQTT redelivery)
      if (await rawTelemetryExists(device.id, messageId)) {
        results.push(makeResult('DUPLICATE', 'Already ingested (same message id)'));
        continue;
      }

      const rawRow = await saveRawTelemetry({
        messageId, deviceId: device.id, fieldId, topic,
        payload: m, state: 'RECEIVED',
      });
      const finish = (state: MessageState, reason?: string, extra?: Partial<MessageResult>) => {
        updateRawTelemetryState(rawRow.id, state, { reason, sensor_type: sensorType, value, unit: m.unit || null, timestamp: m.timestamp || null }).catch(() => {});
        return makeResult(state, reason, extra);
      };

      if (!sensorType || !Number.isFinite(value)) {
        results.push(finish('REJECTED', 'INVALID'));
        continue;
      }
      const ts = normalizeTimestamp(m.timestamp);
      if (!ts) {
        results.push(finish('REJECTED', 'BAD_TIMESTAMP'));
        continue;
      }
      const validation = validateReading({
        device_id: device.id, sensor_type: sensorType, value,
        unit: m.unit || '', timestamp: ts,
      });
      if (!validation.valid) {
        results.push(finish('REJECTED', validation.reason || validation.quality));
        continue;
      }
      const now = Date.now();
      const ageS = Math.abs(now - new Date(ts).getTime()) / 1000;
      const isSuspectClock = ageS > 6 * 3600; // SUSPECT: stored, flagged

      let sensor = await getSensorByDeviceAndType(device.id, sensorType);
      if (!sensor) {
        sensor = await createSensor({ deviceId: device.id, sensorType, unit: m.unit });
      }

      const obs = await insertObservation({
        userId: device.user_id, farmId: farmId || '', fieldId,
        deviceId: device.id, deploymentId: deployment?.id || null,
        sensorId: sensor.id, sensorType,
        timestamp: ts, value, unit: m.unit || sensor.unit || '',
        quality: isSuspectClock ? 'SUSPECT' : 'VALID',
        calibrationVersion: sensor.calibration_version || 1,
        firmwareVersion: m.firmware_version || device.firmware_version || null,
        depthMeters: m.depth_cm != null ? Number(m.depth_cm) / 100 : (m.depth_meters != null ? Number(m.depth_meters) : (deployment?.depth_meters ?? null)),
        geometry: m.lat != null && m.lng != null
          ? { type: 'Point', coordinates: [Number(m.lng), Number(m.lat)] }
          : (deployment?.location ?? null),
        provenance: {
          transport, device_id: device.id, sensor_id: sensor.id, sensor_type: sensorType,
          deployment_id: deployment?.id || null, message_id: messageId,
          sequence: raw?.sequence ?? null, raw_message_id: messageId,
        },
        ingestionMetadata: { ingested_at: new Date().toISOString(), pipeline_version: '2.0.0', dedup_key: messageId },
      });

      // Hardware → evidence: OBSERVED physical measurement powers engines.
      if (farmId) {
        await insertEvidence({
          userId: device.user_id, farmId, fieldId,
          source: 'PHYSICAL_HARDWARE', provider: `agrifur2-device:${transport}`,
          observationTime: ts,
          measurement: {
            value, unit: obs.unit, sensor_type: sensorType, quality: obs.quality,
            calibration_version: sensor.calibration_version || 1,
            depth_m: obs.depth_meters, observation_id: obs.id,
          },
          unit: obs.unit, state: 'OBSERVED', quality: null,
          provenance: {
            device_id: device.id, sensor_id: sensor.id, deployment_id: deployment?.id || null,
            message_id: messageId, transport, calibration_version: sensor.calibration_version || 1,
          },
          deviceId: device.id, sensorId: sensor.id,
        }).catch(() => {});
      }

      await emitEvent('OBSERVATION_RECEIVED', {
        observation_id: obs.id, sensor_type: sensorType, value, unit: obs.unit,
        device_id: device.id, quality: obs.quality, timestamp: ts,
      }, { fieldId, userId: device.user_id }).catch(() => {});

      // device-level metadata piggybacked on telemetry
      if (typeof deviceMeta.battery === 'number' || typeof raw?.battery === 'number') {
        const b = typeof deviceMeta.battery === 'number' ? deviceMeta.battery : raw?.battery;
        await updateDevice(device.id, { battery: Number(b), lastSeenAt: new Date().toISOString() }).catch(() => {});
      }

      results.push(finish(isSuspectClock ? 'SUSPECT' : 'VALIDATED', isSuspectClock ? 'TIMESTAMP_FAR_FROM_NOW' : undefined, {
        observationId: obs.id, value, unit: obs.unit, timestamp: ts,
      }));
    }
  }

  await updateDevice(device.id, { lastSeenAt: new Date().toISOString(), status: 'active' }).catch(() => {});
  const fresh = await getDevice(device.id);
  return { deviceState: deriveDeviceState(fresh || device), results, stored, rejected };
}
