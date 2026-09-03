/**
 * AGRIFUR2 MQTT Client — transport only. The broker is never the database.
 *
 * Topic namespace:
 *   agrifur/v1/devices/{deviceId}/telemetry | heartbeat | status | events
 *   agrifur/v1/devices/{deviceId}/commands   (downlink)
 *   agrifur/v1/devices/{deviceId}/responses  (uplink command acks)
 * Legacy agrifur2/{farm}/{field}/{device}/{sensor} telemetry topics are still
 * parsed for backwards compatibility. Messages go through the shared ingest
 * pipeline (raw preservation → validation → dedupe → observation + evidence).
 */
import { getDevice } from '../../data/sensors';
import { ingestTelemetryBatch } from './ingest';
import { validateReading } from './mqtt-ingestion';
import { recordHeartbeat, recordDeviceEvent } from '../../data/sensors';

let mqttClient: any = null;
let status: 'UNAVAILABLE' | 'CONNECTING' | 'CONNECTED' | 'DEGRADED' = 'UNAVAILABLE';

export function mqttTopic(deviceId: string, kind: 'telemetry' | 'heartbeat' | 'status' | 'events' | 'commands' | 'responses'): string {
  return `agrifur/v1/devices/${deviceId}/${kind}`;
}

export function publishCommand(deviceId: string, command: { id: string; command: string; params?: unknown }): boolean {
  if (!mqttClient || status !== 'CONNECTED') return false;
  try {
    mqttClient.publish(mqttTopic(deviceId, 'commands'), JSON.stringify({
      schemaVersion: '1.0', commandId: command.id, command: command.command,
      params: command.params || {}, issuedAt: new Date().toISOString(),
    }), { qos: 1 });
    return true;
  } catch {
    return false;
  }
}

async function handleTopicMessage(topic: string, payload: Buffer): Promise<void> {
  try {
    let raw: any;
    try { raw = JSON.parse(payload.toString('utf-8')); } catch { return; }
    if (!raw || typeof raw !== 'object') return;

    // agrifur/v1/devices/{deviceId}/{kind}
    const v1 = topic.match(/^agrifur\/v1\/devices\/([^/]+)\/(\w+)$/);
    if (v1) {
      const deviceId = v1[1];
      const kind = v1[2];
      if (raw.device_id && raw.device_id !== deviceId) return;
      const device = await getDevice(deviceId);
      if (!device) return;

      if (kind === 'telemetry') {
        await ingestTelemetryBatch({ device, messages: [raw], transport: 'mqtt', topic });
        return;
      }
      if (kind === 'heartbeat') {
        await recordHeartbeat({
          deviceId,
          battery: raw.battery != null ? Number(raw.battery) : null,
          signalStrength: raw.signal_strength != null ? Number(raw.signal_strength) : (raw.rssi != null ? Number(raw.rssi) : null),
          uptimeS: raw.uptime_s != null ? Number(raw.uptime_s) : null,
          firmwareVersion: raw.firmware_version || null,
          payload: raw,
        });
        await recordDeviceEvent(deviceId, 'HEARTBEAT', { battery: raw.battery ?? null, signal: raw.signal_strength ?? raw.rssi ?? null }).catch(() => {});
        return;
      }
      if (kind === 'status') {
        await recordHeartbeat({ deviceId, payload: raw, status: String(raw.status || 'active').toLowerCase() });
        return;
      }
      if (kind === 'responses') {
        // command ack from device: { commandId, status: ACKED|FAILED, error? }
        const { updateCommand } = await import('../../data/sensors');
        if (raw.command_id || raw.commandId) {
          const cmdId = raw.command_id || raw.commandId;
          await updateCommand(cmdId, {
            status: raw.status === 'ACKED' ? 'ACKED' : raw.status === 'FAILED' ? 'FAILED' : 'ACKED',
            acked_at: new Date().toISOString(),
            ack_message_id: raw.message_id || null,
            error: raw.error || null,
          });
        }
        return;
      }
      if (kind === 'events') {
        await recordDeviceEvent(deviceId, String(raw.type || 'DEVICE_EVENT'), raw.data || raw).catch(() => {});
        return;
      }
      return;
    }

    // legacy agrifur2/{farm}/{field}/{device}/{sensor_type} telemetry
    const { parseTopic } = await import('./mqtt-ingestion');
    const parts = parseTopic(topic);
    if (!parts || !raw.device_id) return;
    const device = await getDevice(raw.device_id);
    if (!device) return;
    await ingestTelemetryBatch({ device, messages: [raw], transport: 'mqtt', topic });
  } catch (e: any) {
    console.error('[MQTT] ingest error:', e.message);
  }
}

export async function connectMqtt(brokerUrl: string, options?: { username?: string; password?: string }) {
  try {
    const mqtt = await import('mqtt');
    status = 'CONNECTING';
    mqttClient = mqtt.connect(brokerUrl, {
      clientId: `agrifur2-backend-${Date.now()}`,
      protocolVersion: 5,
      clean: true,
      connectTimeout: 10000,
      username: options?.username,
      password: options?.password,
      reconnectPeriod: 5000,
    });

    mqttClient.on('connect', () => {
      status = 'CONNECTED';
      mqttClient.subscribe('agrifur/v1/devices/+/telemetry', { qos: 1 });
      mqttClient.subscribe('agrifur/v1/devices/+/heartbeat', { qos: 1 });
      mqttClient.subscribe('agrifur/v1/devices/+/status', { qos: 1 });
      mqttClient.subscribe('agrifur/v1/devices/+/events', { qos: 1 });
      mqttClient.subscribe('agrifur/v1/devices/+/responses', { qos: 1 });
      mqttClient.subscribe('agrifur2/#', { qos: 1 }); // legacy
    });
    mqttClient.on('message', (topic: string, payload: Buffer) => {
      handleTopicMessage(topic, payload).catch(() => {});
    });
    mqttClient.on('error', (err: Error) => {
      console.error('MQTT error:', err.message);
      status = 'DEGRADED';
    });
    mqttClient.on('offline', () => { status = 'CONNECTING'; });
    return true;
  } catch (error: any) {
    status = 'UNAVAILABLE';
    return false;
  }
}

export function isConnected(): boolean {
  return status === 'CONNECTED';
}

export function mqttStatus(): string {
  return status;
}

export function disconnectMqtt(): void {
  if (mqttClient) {
    mqttClient.end();
    mqttClient = null;
  }
  status = 'UNAVAILABLE';
}

export { validateReading };
