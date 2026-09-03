/**
 * Hardware integration tests (sqlite-dev). Device registry, telemetry
 * pipeline (raw preservation → validation → dedupe → observation + OBSERVED
 * evidence), offline sync idempotency, calibration state, truthful derived
 * device states and strict field isolation.
 */
import { createUser, createFarm } from '../src/data/users';
import { createField, getFieldFarm } from '../src/data/fields';
import {
  createDevice, createDeployment, findDeviceByApiKey, recordHeartbeat,
  addCalibration, calibrationStatus, listCalibrations, deriveDeviceState,
  listObservations, createCommand, updateCommand, updateDevice, listDevicesForField,
  listRawTelemetry, listSensorsForField,
} from '../src/data/sensors';
import { ingestTelemetryBatch } from '../src/services/sensors/ingest';
import { listEvidence } from '../src/data/evidence';

const geometry: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[74.42, 18.53], [74.43, 18.53], [74.43, 18.54], [74.42, 18.54], [74.42, 18.53]]],
};

let userA: any, userB: any, farmA: any, fieldA: any;

async function makeUser(email: string) {
  return createUser({ email, password: 'password-123' });
}

function reading(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0', message_id: `mid-${Math.random().toString(36).slice(2, 10)}`,
    sensor_type: 'soil_moisture', value: 42.7, unit: '%',
    timestamp: new Date().toISOString(), depth_meters: 0.15, ...over,
  };
}

beforeAll(async () => {
  userA = await makeUser('hw-a@test.local');
  userB = await makeUser('hw-b@test.local');
  farmA = await createFarm({ userId: userA.id, name: 'HW Farm A' });
  const farmB = await createFarm({ userId: userB.id, name: 'HW Farm B' });
  fieldA = await createField({ userId: userA.id, farmId: farmA.id, name: 'Field A', geometry });
  await createField({ userId: userB.id, farmId: farmB.id, name: 'Field B', geometry });
});

async function registeredDevice(fieldId: string) {
  const device = await createDevice({ userId: userA.id, name: 'Probe-01', type: 'soil_moisture_probe', fieldId });
  const { dbRun } = await import('../src/data/db');
  await dbRun(`UPDATE devices SET api_key = 'key-${device.id.slice(0, 8)}' WHERE id = $1`, [device.id]);
  await createDeployment({ deviceId: device.id, fieldId, deploymentDate: new Date().toISOString().slice(0, 10) });
  return device;
}

describe('device registry & truthful derived states', () => {
  test('device key lookup works; state is derived from real activity', async () => {
    const device = await registeredDevice(fieldA.id);
    const byKey = await findDeviceByApiKey(`key-${device.id.slice(0, 8)}`);
    expect(byKey?.id).toBe(device.id);
    expect(findDeviceByApiKey('bogus')).resolves.toBeNull();
    // no heartbeat yet → UNKNOWN (never claimed ONLINE)
    expect(deriveDeviceState({ status: 'active', last_seen_at: null })).toBe('UNKNOWN');
    const hb = await recordHeartbeat({ deviceId: device.id, battery: 87 });
    expect(deriveDeviceState({ status: 'active', last_seen_at: hb.recorded_at })).toBe('ONLINE');
    expect(deriveDeviceState({ status: 'active', last_seen_at: new Date(Date.now() - 600000).toISOString() })).toBe('STALE');
    expect(deriveDeviceState({ status: 'maintenance', last_seen_at: new Date().toISOString() })).toBe('MAINTENANCE');
  });

  test('field isolation: user B never sees field A devices', async () => {
    const aDevices = await listDevicesForField(fieldA.id, userA.id);
    const bView = await listDevicesForField(fieldA.id, userB.id);
    expect(aDevices.length).toBeGreaterThan(0);
    expect(bView).toHaveLength(0);
  });
});

describe('telemetry pipeline → observation + OBSERVED evidence', () => {
  test('valid reading: raw preserved, observation + evidence created', async () => {
    const device = await registeredDevice(fieldA.id);
    const msg = reading();
    const out = await ingestTelemetryBatch({ device, messages: [msg], transport: 'https' });
    expect(out.stored).toBe(1);
    expect(out.results[0].state).toBe('VALIDATED');
    const obs = await listObservations({ fieldId: fieldA.id, userId: userA.id, sensorType: 'soil_moisture', limit: 10 });
    const mine = obs.find((o) => o.device_id === device.id);
    expect(mine).toBeTruthy();
    expect(mine!.quality).toBe('VALID');
    expect(mine!.provenance).toHaveProperty('message_id');
    expect(mine!.provenance).toHaveProperty('deployment_id');
    // OBSERVED evidence for engines/world model
    const ev = await listEvidence({ fieldId: fieldA.id, userId: userA.id, source: 'PHYSICAL_HARDWARE' });
    const evMine = ev.find((e) => e.provenance?.device_id === device.id);
    expect(evMine).toBeTruthy();
    expect(evMine?.state).toBe('OBSERVED');
    // raw preserved
    const raw = await listRawTelemetry(device.id, 10);
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0].state).toBe('VALIDATED');
  });

  test('out-of-range / malformed readings are REJECTED and never become observations', async () => {
    const device = await registeredDevice(fieldA.id);
    const before = (await listObservations({ fieldId: fieldA.id, userId: userA.id, limit: 500 })).length;
    const bad = await ingestTelemetryBatch({
      device, messages: [reading({ sensor_type: 'soil_moisture', value: 250, message_id: 'bad-range' })], transport: 'https',
    });
    expect(bad.results[0].state).toBe('REJECTED');
    const raw = await listRawTelemetry(device.id, 50);
    const badRaw = raw.find((r) => r.message_id === 'bad-range');
    expect(badRaw?.state).toBe('REJECTED');
    const after = (await listObservations({ fieldId: fieldA.id, userId: userA.id, limit: 500 })).length;
    expect(after).toBe(before); // nothing inserted
  });

  test('offline sync replay is idempotent (message-id dedupe)', async () => {
    const device = await registeredDevice(fieldA.id);
    const msg = reading();
    const first = await ingestTelemetryBatch({ device, messages: [msg], transport: 'offline-sync' });
    expect(first.stored).toBe(1);
    const replay = await ingestTelemetryBatch({ device, messages: [msg], transport: 'offline-sync' });
    expect(replay.stored).toBe(0);
    expect(replay.results[0].state).toBe('DUPLICATE');
    const obs = await listObservations({ fieldId: fieldA.id, userId: userA.id, sensorType: 'soil_moisture', limit: 500 });
    expect(obs.filter((o) => o.device_id === device.id)).toHaveLength(1);
  });

  test('timestamp far in the future is stored but SUSPECT', async () => {
    const device = await registeredDevice(fieldA.id);
    const out = await ingestTelemetryBatch({
      device, messages: [reading({ message_id: 'future-ts', timestamp: new Date(Date.now() + 30 * 86400000).toISOString() })],
      transport: 'https',
    });
    expect(out.results[0].state).toBe('SUSPECT');
  });
});

describe('calibration & commands', () => {
  test('calibration records drive CALIBRATED / CALIBRATION_EXPIRED state', async () => {
    const device = await registeredDevice(fieldA.id);
    const { createSensor } = await import('../src/data/sensors');
    const sensor = await createSensor({ deviceId: device.id, sensorType: 'soil_moisture', unit: '%' });
    expect((await calibrationStatus(sensor)).state).toBe('NOT_CALIBRATED');
    await addCalibration({ sensorId: sensor.id, calibrationData: { offset: 0.5, scale: 1.0 }, method: 'lab-oven', calibratedBy: 'tester' });
    const st = await calibrationStatus(sensor);
    expect(st.state).toBe('CALIBRATED');
    expect(st.version).toBe(1);
    const cals = await listCalibrations(sensor.id);
    expect(cals[0].method).toBe('lab-oven');
    // expired
    await addCalibration({ sensorId: sensor.id, calibrationData: { offset: 0 }, method: 'field', validUntil: new Date(Date.now() - 1000).toISOString() });
    expect((await calibrationStatus(sensor)).state).toBe('CALIBRATION_EXPIRED');
    expect((await listSensorsForField(fieldA.id, userA.id)).some((s) => s.calibration_version >= 2)).toBe(true);
  });

  test('command lifecycle QUEUED → ACKED via data layer', async () => {
    const device = await registeredDevice(fieldA.id);
    const cmd = await createCommand({ deviceId: device.id, fieldId: fieldA.id, userId: userA.id, command: 'sync_time' });
    expect(cmd.status).toBe('QUEUED');
    await updateCommand(cmd.id, { status: 'ACKED', acked_at: new Date().toISOString(), ack_message_id: 'ack-1' });
    const { listDeviceCommands } = await import('../src/data/sensors');
    const rows = await listDeviceCommands(device.id);
    expect(rows[0].status).toBe('ACKED');
    expect(rows[0].ack_message_id).toBe('ack-1');
  });
});

describe('deployment is server-resolved', () => {
  test('device telemetry resolves active deployment and never trusts a client field_id', async () => {
    const device = await registeredDevice(fieldA.id);
    // client claims field B (does not exist for user A); server must ignore it
    const out = await ingestTelemetryBatch({
      device,
      messages: [reading({ message_id: 'client-claim', field_id: 'whatever' })],
      transport: 'https',
    });
    expect(out.stored).toBe(1);
    const obs = await listObservations({ fieldId: fieldA.id, userId: userA.id, sensorType: 'soil_moisture', limit: 500 });
    const mine = obs.find((o) => o.device_id === device.id && (o.provenance as any)?.message_id === 'client-claim');
    expect(mine?.field_id).toBe(fieldA.id);
  });
});
