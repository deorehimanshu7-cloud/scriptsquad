#!/usr/bin/env node
/**
 * AGRIFUR — final acceptance verification (live).
 * Usage: node scripts/verify_final.mjs <base-url>
 *
 * Exercises, against a RUNNING instance:
 *  1. health + auth (demo account)
 *  2. field CRUD + geo-anchoring + isolation (second user cannot read demo's
 *     field, demo cannot read the second user's field)
 *  3. SSE stream: foreign field_id → 403; own field stream connects
 *  4. HTTPS telemetry pipeline: register device → ingest → dedupe → reject
 *     unknown device / out-of-range / malformed payload → observation history
 *  5. Satellite: summary note is truthful (no Landsat claim), manual search
 *     rejects landsat-c2-l2, real sentinel search works
 *  6. World model / twin / intelligence / provider health / system status
 *  7. AI assistant grounded fallback (no LLM key → LOCAL_GROUNDED_FALLBACK)
 */
const base = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};

async function req(path, opts = {}, token) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
}

const SEED_POLYGON = {
  type: "Polygon",
  coordinates: [[[73.7882, 20.0001], [73.7891, 20.0004], [73.7904, 20.0005], [73.7916, 20.0002], [73.7923, 19.9993], [73.7918, 19.9984], [73.7905, 19.9981], [73.7892, 19.9986], [73.7885, 19.9994], [73.7882, 20.0001]]],
};

async function main() {
  // 1. health + auth -------------------------------------------------------
  const health = await req("/api/health");
  check("GET /api/health", health.status === 200, `status ${health.status}`);

  const login = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "demo@agrifur.dev", password: "agrifur-demo" }),
  });
  const token = login.json?.token;
  check("demo login", login.status === 200 && !!token, login.json?.user?.email ?? "");
  if (!token) { console.log("\nABORT: cannot authenticate."); process.exit(1); }

  const me = await req("/api/auth/me", {}, token);
  check("GET /api/auth/me", me.status === 200 && !!me.json?.user?.id, me.json?.user?.email);

  // 2. field CRUD + geo-anchoring + isolation ------------------------------
  const fields = await req("/api/fields", {}, token);
  const demoField = fields.json?.fields?.find((f) => f.name?.includes("North Plot")) ?? fields.json?.fields?.[0];
  check("demo field present", !!demoField?.id, demoField ? `${demoField.name} · ${(demoField.area_m2 / 1e4).toFixed(1)} ha · centroid ${demoField.centroid_lat},${demoField.centroid_lon}` : "none");
  check("field geometry is real GeoJSON", !!demoField?.geometry?.type && demoField.geometry.type === "Polygon", `type=${demoField?.geometry?.type} rings=${demoField?.geometry?.coordinates?.length}`);

  // second user — full isolation check
  const u2email = `audit_${Date.now()}@agrifur.dev`;
  const reg2 = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "Audit User 2", email: u2email, password: "auditpass123" }),
  });
  const token2 = reg2.json?.token;
  check("second user register", reg2.status === 201 && !!token2, u2email);

  const f2fields = await req("/api/fields", {}, token2);
  check("second user sees no demo fields", Array.isArray(f2fields.json?.fields) && f2fields.json.fields.length === 0, `${f2fields.json?.fields?.length ?? "?"} fields`);

  const forbiddenRead = await req(`/api/fields/${demoField.id}/world-model`, {}, token2);
  check("foreign field read → 403", forbiddenRead.status === 403, `status ${forbiddenRead.status} (${forbiddenRead.json?.error?.code ?? ""})`);

  const forbiddenEv = await req(`/api/fields/${demoField.id}/evidence`, {}, token2);
  check("foreign field evidence → 403", forbiddenEv.status === 403, `status ${forbiddenEv.status}`);

  const forbiddenDev = await req(`/api/fields/${demoField.id}/devices`, {}, token2);
  check("foreign field devices → 403", forbiddenDev.status === 403, `status ${forbiddenDev.status}`);

  // second user creates their own field, then demo cannot touch it
  const farm2 = await req("/api/farms", { method: "POST", body: JSON.stringify({ name: "Audit Farm 2" }) }, token2);
  const farm2id = farm2.json?.farm?.id;
  const field2 = await req("/api/fields", {
    method: "POST",
    body: JSON.stringify({ farm_id: farm2id, name: "Audit Field 2", geometry: SEED_POLYGON }),
  }, token2);
  const f2id = field2.json?.field?.id;
  check("second user creates field", field2.status === 201 && !!f2id, f2id ? `${field2.json.field.name} (${(field2.json.field.area_m2 / 1e4).toFixed(1)} ha)` : "");
  const demoOnF2 = await req(`/api/fields/${f2id}/digital-twin`, {}, token);
  check("demo on foreign field → 403", demoOnF2.status === 403, `status ${demoOnF2.status}`);

  // 3. SSE scoping ----------------------------------------------------------
  const sseForeign = await req(`/api/events/stream?field_id=${f2id}`, {}, token);
  check("SSE with foreign field_id → 403", sseForeign.status === 403, `status ${sseForeign.status}`);
  // open stream check: fetch and cancel as soon as headers arrive (stream stays open)
  const ac = new AbortController();
  const sseRes = await fetch(`${base}/api/events/stream?field_id=${demoField.id}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  check("SSE with own field_id → 200 stream", sseRes.status === 200, `status ${sseRes.status}`);
  ac.abort();

  // 4. HTTPS telemetry pipeline ---------------------------------------------
  const extId = `AGRIFUR-AUDIT-${Date.now().toString(36).toUpperCase()}`;
  const devReg = await req(`/api/fields/${demoField.id}/devices`, {
    method: "POST",
    body: JSON.stringify({ name: "Audit Node", device_id: extId, kind: "sensor_node", firmware_version: "9.9.9" }),
  }, token);
  check("device registered", devReg.status === 201 && !!devReg.json?.device?.id, extId);
  const devRow = devReg.json?.device;
  const devDbId = devRow?.id;

  const ingest1 = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({
      device_id: devDbId,
      readings: [
        { sensor_type: "soil_moisture", value: 42.7 },
        { sensor_type: "temperature", value: 28.4 },
        { sensor_type: "humidity", value: 67.2 },
      ],
    }),
  }, token);
  check("telemetry ingest (real readings)", ingest1.status === 200 && ingest1.json?.inserted === 3, JSON.stringify(ingest1.json ?? {}));

  const ingestDup = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({
      device_id: devDbId,
      readings: [
        { sensor_type: "soil_moisture", value: 42.7, ingestion_id: "dup-key-1" },
        { sensor_type: "temperature", value: 28.4, ingestion_id: "dup-key-2" },
      ],
    }),
  }, token);
  const dupAgain = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({
      device_id: devDbId,
      readings: [{ sensor_type: "soil_moisture", value: 42.7, ingestion_id: "dup-key-1" }],
    }),
  }, token);
  check("duplicate ingestion_id skipped", dupAgain.json?.inserted === 0 && dupAgain.json?.skipped_duplicates === 1, JSON.stringify(dupAgain.json ?? {}));

  const badRange = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({
      device_id: devDbId,
      readings: [{ sensor_type: "soil_moisture", value: 9999 }],
    }),
  }, token);
  check("out-of-range reading rejected (0 inserted)", badRange.status === 200 && badRange.json?.inserted === 0 && badRange.json?.rejected === 1, JSON.stringify(badRange.json ?? {}));

  const unknownDev = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({ device_id: "dev_does_not_exist_xyz", readings: [{ sensor_type: "temperature", value: 25 }] }),
  }, token);
  check("unknown device → 404", unknownDev.status === 404, `status ${unknownDev.status}`);

  const malformed = await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({ device_id: 123, readings: "nope" }),
  }, token);
  check("malformed payload → 400 VALIDATION", malformed.status === 400 && malformed.json?.error?.code === "VALIDATION", `status ${malformed.status} code=${malformed.json?.error?.code}`);

  const obsHist = await req(`/api/fields/${demoField.id}/observations?type=soil_moisture`, {}, token);
  const smRows = (obsHist.json?.observations ?? []).filter((o) => o.sensor_type === "soil_moisture");
  check("observation history persisted", obsHist.status === 200 && smRows.length >= 1 && smRows.every((o) => o.quality === "high"), `${smRows.length} soil_moisture row(s), quality=${[...new Set(smRows.map((o) => o.quality))].join(",")}`);

  const evSensor = await req(`/api/fields/${demoField.id}/evidence?domain=sensor`, {}, token);
  const sensorEv = (evSensor.json?.evidence ?? []).filter((e) => e.domain === "sensor");
  check("OBSERVED sensor evidence promoted", sensorEv.length >= 3 && sensorEv.every((e) => e.state === "OBSERVED"), `${sensorEv.length} rows, states=${[...new Set(sensorEv.map((e) => e.state))].join(",")}`);

  // 5. satellite truthfulness ------------------------------------------------
  const satSum = await req(`/api/fields/${demoField.id}/satellite/summary`, {}, token);
  const note = satSum.json?.summary?.note ?? "";
  check("satellite summary note is truthful (no Landsat claim)", satSum.status === 200 && !/Landsat 8\/9/i.test(note) && !/Landsat,\s*$/.test(note) && /Landsat is NOT available/.test(note), satSum.json?.summary?.total ? `${satSum.json.summary.total} products, provider ${satSum.json.summary.provider_status?.status}` : note.slice(0, 120));

  const from = new Date(Date.now() - 30 * 864e5).toISOString();
  const to = new Date().toISOString();
  const landsatOnly = await req(`/api/fields/${demoField.id}/satellite/search`, {
    method: "POST",
    body: JSON.stringify({ from, to, collections: ["landsat-c2-l2"] }),
  }, token);
  check("manual search rejects landsat-only request", landsatOnly.status === 400, `status ${landsatOnly.status} (${landsatOnly.json?.error?.message ?? ""})`);
  const mixedSearch = await req(`/api/fields/${demoField.id}/satellite/search`, {
    method: "POST",
    body: JSON.stringify({ from, to, collections: ["sentinel-2-l2a", "landsat-c2-l2"], limit: 5 }),
  }, token);
  check("mixed search silently drops landsat (never sent to STAC)", mixedSearch.status === 200 && mixedSearch.json?.searched?.collections?.length === 1 && mixedSearch.json.searched.collections[0] === "sentinel-2-l2a", JSON.stringify(mixedSearch.json?.searched ?? {}));

  const realSearch = await req(`/api/fields/${demoField.id}/satellite/search`, {
    method: "POST",
    body: JSON.stringify({ from, to, collections: ["sentinel-2-l2a"], limit: 5 }),
  }, token);
  check("manual STAC search (sentinel-2-l2a) works", realSearch.status === 200 && realSearch.json?.ok, realSearch.json?.added != null ? `added ${realSearch.json.added}, total ${realSearch.json.total}` : JSON.stringify(realSearch.json).slice(0, 120));

  const indices = await req(`/api/fields/${demoField.id}/satellite/indices`, {}, token);
  check("indices honest AUTH_REQUIRED (no fabricated NDVI)", indices.status === 200 && indices.json?.status === "AUTH_REQUIRED" && (indices.json?.indices ?? []).length === 0, `status=${indices.json?.status}`);

  // 6. world model / twin / intelligence / providers / system ----------------
  const wm = await req(`/api/fields/${demoField.id}/world-model`, {}, token);
  const doms = wm.json?.world_model?.snapshot?.domains ?? [];
  check("world model composed", wm.status === 200 && doms.length > 0, doms.map((d) => `${d.domain}=${d.state}(${d.count})`).join(" "));

  const twin = await req(`/api/fields/${demoField.id}/digital-twin`, {}, token);
  const layers = twin.json?.twin?.layers ?? {};
  check("digital twin layers truthful", twin.status === 200 && !!layers.terrain && !!layers.sensors && !!layers.soil && !!layers.satellite,
    `terrain=${layers.terrain?.state} soil=${layers.soil?.state} sensors=${layers.sensors?.state} sat=${layers.satellite?.state}`);
  check("twin sensors show OBSERVED after ingest", layers.sensors?.state === "OBSERVED", `state=${layers.sensors?.state}`);

  const intel = await req(`/api/fields/${demoField.id}/intelligence`, {}, token);
  const i = intel.json ?? {};
  check("intelligence engines ran", intel.status === 200 && (i.risks?.length ?? 0) > 0 && (i.uncertainties?.length ?? 0) > 0, `${i.risks?.length ?? 0} risks, ${i.anomalies?.length ?? 0} anomalies, ${i.uncertainties?.length ?? 0} uncertainties, ${i.contradictions?.length ?? 0} contradictions`);

  const prov = await req("/api/providers", {}, token);
  const provList = prov.json?.providers ?? [];
  const pstat = (id) => provList.find((p) => p.id === id)?.health?.status ?? "?";
  check("providers truthful", prov.status === 200 && provList.length > 0,
    `copernicus=${pstat("copernicus")} soilgrids=${pstat("soilgrids")} mqtt=${pstat("mqtt-broker")} water-india=${pstat("water-india")} llm=${pstat("llm")}`);
  // soilgrids must be truthful: either serving real SoilGrids data (REST paused →
  // WCS fallback = AVAILABLE) or reporting an explicit failure state — never fabricated.
  check("soilgrids truthful (real data via WCS fallback, or honest failure)", /AVAILABLE|DATA_QUALITY_FAILURE|UNAVAILABLE|TIMEOUT|PROVIDER_ERROR/.test(pstat("soilgrids")), `soilgrids=${pstat("soilgrids")}`);
  check("mqtt-broker honest NOT_CONFIGURED", pstat("mqtt-broker") === "NOT_CONFIGURED", `mqtt=${pstat("mqtt-broker")}`);

  const sys = await req("/api/system/status", {}, token);
  const s = sys.json ?? {};
  check("system status + worker cadence", sys.status === 200 && s.workers?.soil_interval_seconds === 21600, `soil_interval=${s.workers?.soil_interval_seconds}s`);
  check("system status reports DB ok", s.database?.ok === true, s.database?.location);

  // 7. AI assistant grounded fallback ---------------------------------------
  const asess = await req("/api/assistant/sessions", {
    method: "POST",
    body: JSON.stringify({ field_id: demoField.id, title: "Final audit" }),
  }, token);
  const asessId = asess.json?.session?.id;
  const msg = await req(`/api/assistant/sessions/${asessId}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "What is the soil moisture in this field?" }),
  }, token);
  const answer = msg.json?.answer;
  check("assistant answers grounded (no LLM key)", msg.status === 200 && answer?.mode === "LOCAL_GROUNDED_FALLBACK", `mode=${answer?.mode}`);
  check("assistant carries evidence refs + uncertainty", Array.isArray(answer?.evidence) && typeof answer?.uncertainty === "string", `${answer?.evidence?.length ?? 0} evidence refs`);
  check("assistant answer contains truth states", typeof answer?.answer === "string" && /OBSERVED|NO_DATA|UNKNOWN|DERIVED/.test(answer.answer ?? ""), answer?.answer?.slice(0, 90).replace(/\n/g, " "));

  const aiCtx = await req(`/api/fields/${demoField.id}/ai-context?focus=sensors`, {}, token);
  check("ai-context endpoint field-scoped + focused", aiCtx.status === 200 && aiCtx.json?.ai_context?.focus === "sensors", `focus=${aiCtx.json?.ai_context?.focus}`);
  const aiCtxForbidden = await req(`/api/fields/${demoField.id}/ai-context`, {}, token2);
  check("ai-context foreign → 403", aiCtxForbidden.status === 403, `status ${aiCtxForbidden.status}`);

  // 8. realtime ownership isolation: user B's events must never reach user A's stream
  const u3email = `sse_${Date.now()}@agrifur.dev`;
  const reg3 = await req("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ name: "SSE User 3", email: u3email, password: "ssepass123" }),
  });
  const token3 = reg3.json?.token;
  const farm3 = await req("/api/farms", { method: "POST", body: JSON.stringify({ name: "SSE Farm 3" }) }, token3);
  const field3 = await req("/api/fields", {
    method: "POST",
    body: JSON.stringify({ farm_id: farm3.json?.farm?.id, name: "SSE Field 3", geometry: SEED_POLYGON }),
  }, token3);
  const f3id = field3.json?.field?.id;
  const dev3 = await req(`/api/fields/${f3id}/devices`, {
    method: "POST",
    body: JSON.stringify({ name: "SSE Node 3", device_id: `AGRIFUR-SSE-${Date.now().toString(36).toUpperCase()}` }),
  }, token3);
  const dev3id = dev3.json?.device?.id;

  const readStream = async (tokenX, ms) => {
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events/stream`, { headers: { Authorization: `Bearer ${tokenX}` }, signal: ac.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const events = [];
    const deadline = Date.now() + ms;
    try {
      let buf = "";
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* skip */ }
        }
      }
    } catch { /* aborted */ }
    ac.abort();
    return events;
  };

  const demoStreamP = readStream(token, 6500);
  const user3StreamP = readStream(token3, 6500);
  await new Promise((r) => setTimeout(r, 500));

  // user 3 ingests telemetry → SENSOR_TELEMETRY/WORLD_MODEL_UPDATED/RISK_UPDATED events
  await req(`/api/fields/${f3id}/observations`, {
    method: "POST",
    body: JSON.stringify({ device_id: dev3id, readings: [{ sensor_type: "soil_moisture", value: 33.3 }] }),
  }, token3);
  // demo ingests telemetry → events for the demo field
  const demoDevs = (await req(`/api/fields/${demoField.id}/devices`, {}, token)).json?.devices ?? [];
  const demoDevId = demoDevs[0]?.id;
  await req(`/api/fields/${demoField.id}/observations`, {
    method: "POST",
    body: JSON.stringify({ device_id: demoDevId, readings: [{ sensor_type: "humidity", value: 60 }] }),
  }, token);

  const demoEvents = await demoStreamP;
  const user3Events = await user3StreamP;
  const demoGotUser3 = demoEvents.some((e) => e.type === "SENSOR_TELEMETRY" && String(e.user_id) === reg3.json?.user?.id);
  const user3GotOwn = user3Events.some((e) => e.type === "SENSOR_TELEMETRY" && String(e.user_id) === reg3.json?.user?.id);
  const user3GotDemo = user3Events.some((e) => e.type === "SENSOR_TELEMETRY" && String(e.user_id) === me.json?.user?.id);
  check("realtime: user A stream receives zero user-B telemetry", !demoGotUser3, `demo saw ${demoEvents.filter((e) => e.type === "SENSOR_TELEMETRY").length} telemetry event(s)`);
  check("realtime: user B stream receives own telemetry", user3GotOwn, `${user3Events.filter((e) => e.type === "SENSOR_TELEMETRY").length} own event(s)`);
  check("realtime: user B stream receives zero demo telemetry", !user3GotDemo, "isolated");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error("VERIFY ERROR:", e); process.exit(1); });