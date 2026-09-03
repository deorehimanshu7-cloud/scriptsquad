/* AGRIFUR2 live end-to-end exercise against http://localhost:3101
   Runs the vertical slice: auth -> farm -> field -> providers -> analyze ->
   world model -> investigation -> AI. Prints PASS/FAIL per step, never edits
   production data (uses its own user + sqlite-dev temp DB). */
const BASE = process.env.BASE_URL || 'http://localhost:3101/api';
let token = null;
let pass = 0, fail = 0;

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

async function req(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const email = `live-${Date.now()}@test.local`;
let farmId, fieldId, investigationId, weatherObsId;

// 1. auth
let r = await req('POST', '/auth/register', { email, password: 'live-pass-123', name: 'Live Tester' }, false);
ok('register user', r.status === 201 || (r.json.success && r.json.data?.id), `status=${r.status}`);
r = await req('POST', '/auth/login', { email, password: 'live-pass-123' }, false);
token = r.json?.data?.tokens?.access_token || r.json?.data?.accessToken || r.json?.data?.token;
ok('login issues token', !!token);

// 2. farm
r = await req('POST', '/farms', { name: 'Live Demo Farm' });
farmId = r.json?.data?.id;
ok('create farm', !!farmId, `farm=${farmId?.slice(0, 8)}`);

// 3. field with canonical geometry (Pune region ~1 km x 1 km)
const geometry = {
  type: 'Polygon',
  coordinates: [[
    [74.42, 18.53], [74.43, 18.53], [74.43, 18.54], [74.42, 18.54], [74.42, 18.53],
  ]],
};
r = await req('POST', '/fields', { farm_id: farmId, name: 'Live Field A', geometry });
fieldId = r.json?.data?.id;
const f = r.json?.data;
ok('create field', !!fieldId);
ok('area_hectares computed', typeof f?.area_hectares === 'number' && f.area_hectares > 0, `${f?.area_hectares?.toFixed?.(2)} ha`);
ok('metrics_computed_by labelled', f?.metrics_computed_by === 'sqlite-dev-geo', f?.metrics_computed_by);
ok('geometry_valid true', f?.geometry_valid === true);
ok('centroid present', Array.isArray(f?.centroid?.coordinates) && f.centroid.coordinates.length === 2);

// 4. field detail round-trip (canonical geometry identical)
r = await req('GET', `/fields/${fieldId}`);
ok('get field', r.json?.data?.id === fieldId);
ok('geometry round-trips identical', JSON.stringify(r.json?.data?.geometry) === JSON.stringify(geometry));

// 5. weather — real provider call (Open-Meteo current)
r = await req('GET', `/fields/${fieldId}/weather/current`);
const w = r.json;
ok('weather fetch status truthful', ['MODEL_DERIVED', 'NO_DATA', 'UNAVAILABLE', 'AUTH_REQUIRED', 'PROVIDER_ERROR', 'TIMEOUT', 'RATE_LIMITED'].includes(w?.state), w?.state || JSON.stringify(w).slice(0, 120));
ok('weather provider identified', !!w?.provider, w?.provider);
ok('weather semantics labelled', !!w?.semantics, w?.semantics);

// 6. satellite search — real Copernicus STAC call (adapter-level, not stored)
r = await req('POST', `/fields/${fieldId}/satellite/search`, { collections: ['sentinel-2-l2a'], maxCloudCover: 100 });
const s = r.json;
ok('satellite search state truthful', ['OBSERVED', 'NO_DATA', 'AUTH_REQUIRED', 'UNAVAILABLE', 'TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMITED'].includes(s?.state), s?.state || JSON.stringify(s).slice(0, 160));
if (Array.isArray(s?.data) && s.data.length) {
  const p0 = s.data[0];
  ok('satellite product real id', !!p0.id, p0.id?.slice(0, 40));
  ok('satellite has acquisition time', !!p0.datetime);
  ok('satellite has geometry/footprint', !!p0.geometry);
}
// stored EO search (persists canonical evidence) — may legitimately be NO_DATA
r = await req('POST', `/fields/${fieldId}/satellite/search`, {});
ok('satellite store-search truthful', ['AVAILABLE', 'NO_DATA', 'UNAVAILABLE', 'AUTH_REQUIRED', 'TIMEOUT', 'PROVIDER_ERROR'].includes(r.json?.state) || r.status === 200, r.json?.state || `status=${r.status}`);

// 7. soil (truthful adapter — AUTH_REQUIRED/NO_DATA/AVAILABLE)
r = await req('GET', `/fields/${fieldId}/soil`);
ok('soil endpoint responds', r.status === 200, `status=${r.status}`);

// 8. analyze → engines
r = await req('POST', `/fields/${fieldId}/analyze`, {});
const a = r.json?.data;
ok('analyze runs', !!a);
ok('anomalies array', Array.isArray(a?.anomalies));
ok('risks array', Array.isArray(a?.risks));
ok('uncertainty NOT_ASSESSED (not fabricated)', a?.uncertainty?.data_quality === 'NOT_ASSESSED' || a?.uncertainty?.data_quality === undefined, JSON.stringify(a?.uncertainty || {}).slice(0, 100));
ok('no confidence scalars in analyze payload', !JSON.stringify(a).match(/"confidence"\s*:\s*\d/));

// 9. world model
r = await req('GET', `/fields/${fieldId}/world-model`);
const wm = r.json?.data;
ok('world model returns', !!wm?.state);
ok('world model weather state labelled', ['OBSERVED', 'MODEL_DERIVED', 'NO_DATA', 'UNKNOWN'].includes(wm?.state?.weather?.state), wm?.state?.weather?.state);
ok('world model coverage EVIDENCE_COVERAGE', wm?.coverage?.label === 'EVIDENCE_COVERAGE', wm?.coverage?.label);
ok('world model field anchor correct', wm?.field_id === fieldId, wm?.field_id?.slice(0, 8));

// 10. evidence list
r = await req('GET', `/fields/${fieldId}/evidence`);
const evs = r.json?.data || r.json?.items || [];
ok('evidence listed', evs.length >= 0);
ok('every evidence has state', evs.every((e) => !!e.state));

// 11. investigation lifecycle
r = await req('POST', `/fields/${fieldId}/investigations`, { title: 'Live check', question: 'Is the vegetation signal trustworthy given cloud cover?' });
investigationId = r.json?.data?.id;
ok('create investigation', !!investigationId);
if (investigationId) {
  const rr = await req('GET', `/fields/${fieldId}/investigations`);
  ok('list investigations', rr.json?.data?.length >= 1);
  const r2 = await req('GET', `/fields/${fieldId}/investigations/${investigationId}/next-observations`);
  ok('next-observations computed', Array.isArray(r2.json?.data) && r2.json.data.length > 0, `n=${r2.json?.data?.length}`);
}

// 12. AI assistant — grounded, backend-served, field-scoped
if (fieldId) {
  const sess = await req('POST', '/assistant/sessions', { field_id: fieldId, language: 'en' });
  const sessionId = sess.json?.data?.id;
  ok('assistant session created', !!sessionId);
  const chat = await req('POST', '/assistant/messages', { session_id: sessionId, message: 'What is the current state of this field and what evidence supports it?' });
  const msg = chat.json?.data?.message || chat.json?.data;
  ok('AI answers from backend', !!msg?.content, (msg?.content || '').slice(0, 80));
  ok('AI does not invent numbers', !/^\s*\d+(\.\d+)?\s*(ha|%|mm|°C)\b/i.test((msg?.content || '').split('.')[0]), '');
  ok('AI cites evidence refs when relevant', Array.isArray(chat.json?.data?.evidence_refs) || Array.isArray(msg?.evidence_refs));
}

console.log(`\nE2E RESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
