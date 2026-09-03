/* Live hardware + voice E2E against http://localhost:3001 (sqlite-dev).
   Device register → deploy → telemetry → sync replay dedupe → commands
   (safe accepted, actuator rejected) → calibrations → hardware-health →
   voice device register/sync/status. Truthful states only. */
const BASE = process.env.BASE_URL || 'http://localhost:3001/api';
let token = null;
let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}
async function req(method, path, body, key) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-device-key'] = key;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const email = `hw-live-${Date.now()}@test.local`;
let r = await req('POST', '/auth/register', { email, password: 'password-123', name: 'HW Live' }, null);
token = r.json?.data?.tokens?.access_token || token;
r = await req('POST', '/auth/login', { email, password: 'password-123' }, null);
token = r.json?.data?.tokens?.access_token;
ok('auth', !!token);

const farm = (await req('POST', '/farms', { name: 'HW Farm' })).json.data;
const geom = { type: 'Polygon', coordinates: [[[74.42, 18.53], [74.43, 18.53], [74.43, 18.54], [74.42, 18.54], [74.42, 18.53]]] };
const field = (await req('POST', '/fields', { farm_id: farm.id, name: 'HW Field', geometry: geom })).json.data;
ok('field created', !!field.id);

// 1. device registry
const reg = await req('POST', '/devices/register', { name: 'Probe-Live-01', type: 'soil_moisture_probe', field_id: field.id, firmware_version: '1.4.2' });
const deviceId = reg.json?.data?.device_id;
const deviceKey = reg.json?.data?.device_key;
ok('device registered with key', !!deviceId && !!deviceKey);

const listDevices = await req('GET', '/devices');
ok('device list returns device', listDevices.json?.data?.some((d) => d.id === deviceId));
ok('device list never re-exposes api_key', listDevices.json?.data?.every((d) => d.api_key === undefined));

// 2. telemetry via HTTPS device key
const ts = new Date().toISOString();
const tel = await req('POST', `/devices/${deviceId}/telemetry`, [
  { message_id: 'live-1', schemaVersion: '1.0', sensor_type: 'soil_moisture', value: 24.5, unit: '%', timestamp: ts, depth_meters: 0.15 },
  { message_id: 'live-2', sensor_type: 'soil_temperature', value: 28.2, unit: 'C', timestamp: ts },
], deviceKey);
ok('telemetry stored 2', tel.json?.data?.stored === 2, `stored=${tel.json?.data?.stored} rejected=${tel.json?.data?.rejected}`);
ok('telemetry device state derived', tel.json?.data?.device_state === 'ONLINE', tel.json?.data?.device_state);

// 3. raw telemetry & evidence
const sensors = await req('GET', `/fields/${field.id}/sensors`);
ok('sensors auto-created', sensors.json?.data?.length >= 2, `n=${sensors.json?.data?.length}`);
const soilSensor = sensors.json?.data?.find((s) => s.sensor_type === 'soil_moisture');
ok('sensor calibration state NOT_CALIBRATED initially', soilSensor?.calibration?.state === 'NOT_CALIBRATED', soilSensor?.calibration?.state);

// 4. calibration
const cal = await req('POST', `/sensors/${soilSensor.id}/calibrations`, { calibration_data: { offset: 0.2, scale: 1.01 }, method: 'lab-oven', valid_until: new Date(Date.now() + 86400000 * 30).toISOString() });
ok('calibration recorded', cal.status === 201, cal.status);
const calGet = await req('GET', `/sensors/${soilSensor.id}/calibrations`);
ok('calibration state CALIBRATED', calGet.json?.data?.calibration_state?.state === 'CALIBRATED', calGet.json?.data?.calibration_state?.state);

// 5. offline sync replay — idempotent
const sync = await req('POST', `/devices/${deviceId}/sync`, { messages: [{ message_id: 'live-1', sensor_type: 'soil_moisture', value: 24.5, unit: '%', timestamp: ts }] }, deviceKey);
ok('sync replay dedupes (DUPLICATE)', sync.json?.data?.results?.[0]?.state === 'DUPLICATE', sync.json?.data?.results?.[0]?.state);
ok('sync stored 0 on replay', sync.json?.data?.stored === 0);

// 6. bad reading rejected & raw preserved
const bad = await req('POST', `/devices/${deviceId}/telemetry`, [{ message_id: 'live-bad', sensor_type: 'soil_moisture', value: 900, unit: '%', timestamp: ts }], deviceKey);
ok('out-of-range rejected', bad.json?.data?.results?.[0]?.state === 'REJECTED', JSON.stringify(bad.json?.data?.results?.[0]));

// 7. commands: safe ok, actuator rejected
const cmd = await req('POST', `/devices/${deviceId}/commands`, { command: 'set_sampling_interval', params: { seconds: 300 } });
ok('safe command created', cmd.status === 201 && !!cmd.json?.data?.id, `${cmd.status} ${cmd.json?.data?.status || ''}`);
const act = await req('POST', `/devices/${deviceId}/commands`, { command: 'restart_device' });
ok('actuator command rejected by default', act.status === 403, act.json?.error?.code || act.status);
const cmds = await req('GET', `/devices/${deviceId}/commands`);
ok('commands listed', Array.isArray(cmds.json?.data) && cmds.json.data.length >= 1);

// 8. heartbeat + derived status
const hb = await req('POST', `/devices/${deviceId}/heartbeat`, { battery: 84, signal_strength: -58, uptime_s: 3600, firmware_version: '1.4.2' }, deviceKey);
ok('heartbeat recorded', hb.json?.data?.derived_state === 'ONLINE', hb.json?.data?.derived_state);
const st = await req('GET', `/devices/${deviceId}/status`);
ok('status endpoint truthful', !!st.json?.data?.derived_state, st.json?.data?.derived_state);

// 9. hardware health + field isolation (user B sees nothing)
const health = await req('GET', `/fields/${field.id}/hardware-health`);
ok('hardware-health present', health.json?.data?.device_count >= 1, `devices=${health.json?.data?.device_count}`);
ok('health derives states', (health.json?.data?.state_counts?.ONLINE || 0) >= 1, JSON.stringify(health.json?.data?.state_counts));

const emailB = `hw-b-${Date.now()}@test.local`;
await req('POST', '/auth/register', { email: emailB, password: 'password-123', name: 'B' }, null);
const loginB = await req('POST', '/auth/login', { email: emailB, password: 'password-123' });
const tokenB = loginB.json?.data?.tokens?.access_token;
const bView = await fetch(`${BASE}/fields/${field.id}/devices`, { headers: { Authorization: `Bearer ${tokenB}` } });
const bJson = await bView.json().catch(() => ({}));
ok('field isolation: user B blocked from field A devices', bView.status === 403 || bView.status === 404 || bJson.data?.devices?.length === 0, `status=${bView.status}`);

// 10. voice device
const vr = await req('POST', '/voice-devices/register', { name: 'Voice-Unit-1', field_id: field.id });
const vDeviceId = vr.json?.data?.device_id;
const vKey = vr.json?.data?.device_key;
ok('voice device registered', !!vDeviceId && !!vKey);
const vs = await req('POST', `/voice-devices/${vDeviceId}/sync`, { last_sync: new Date().toISOString() }, vKey);
ok('voice sync returns cached observations with real timestamps', Array.isArray(vs.json?.data?.cache) && vs.json.data.cache.some((c) => c.sensor_type === 'soil_moisture' && typeof c.observed_at === 'string'), `cache=${vs.json?.data?.cache?.length}`);
ok('voice sync marks offline-truth note', (vs.json?.data?.cache_note || '').includes('never “current”'));
const vst = await req('GET', `/voice-devices/${vDeviceId}/status`, null, vKey);
ok('voice status derives online mode', vst.json?.data?.derived_state === 'ONLINE', vst.json?.data?.derived_state);

// 11. assistant message includes sensor context (local grounded engine)
const sess = await req('POST', '/assistant/sessions', { field_id: field.id, language: 'en' });
const answer = await req('POST', '/assistant/messages', { session_id: sess.json?.data?.id, message: 'What is the soil moisture reading and when was it observed?' });
const content = (answer.json?.data?.message?.content || '').toLowerCase();
ok('AI answers with sensor context', content.includes('soil_moisture') || content.includes('moisture'), content.slice(0, 90));
ok('AI quotes OBSERVED + timestamp', content.includes('observed'), '');

console.log(`\nHARDWARE E2E: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
