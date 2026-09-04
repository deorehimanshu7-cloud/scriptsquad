#!/usr/bin/env node
/**
 * AGRIFUR2 live end-to-end smoke check.
 * Usage: node scripts/smoke_live.mjs <base-url>
 * Exercises auth → farms/fields → world model → evidence → intelligence →
 * satellite → twin → system → refresh against a RUNNING instance.
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

const main = async () => {
  // 0. health
  const health = await req("/api/health");
  check("GET /api/health", health.status === 200, `status ${health.status}`);

  // 1. auth
  const login = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email: "demo@agrifur.dev", password: "agrifur-demo" }),
  });
  const token = login.json?.token;
  check("POST /api/auth/login", login.status === 200 && !!token);
  if (!token) { console.log("\nABORT: cannot authenticate."); process.exit(1); }

  const me = await req("/api/auth/me", {}, token);
  check("GET /api/auth/me", me.status === 200 && !!me.json?.user, me.json?.user?.email);

  // 2. farms + fields
  const farms = await req("/api/farms", {}, token);
  check("GET /api/farms", farms.status === 200 && Array.isArray(farms.json?.farms));
  const fields = await req("/api/fields", {}, token);
  const field = fields.json?.fields?.[0];
  check("GET /api/fields", fields.status === 200 && !!field, field ? `${field.name} (${(field.area_m2 / 1e4).toFixed(1)} ha)` : "no fields");
  if (!field) { console.log("\nABORT: no field available."); process.exit(1); }
  const fid = field.id;

  // 3. field-level: world model, evidence, intelligence, satellite, twin
  const wm = await req(`/api/fields/${fid}/world-model`, {}, token);
  const wmDomains = wm.json?.world_model?.snapshot?.domains ?? wm.json?.domains ?? [];
  check("GET world-model", wm.status === 200 && wmDomains.length > 0, wmDomains.map((d) => `${d.domain}=${d.state}(${d.count})`).join(" "));

  const ev = await req(`/api/fields/${fid}/evidence?limit=5`, {}, token);
  check("GET evidence", ev.status === 200 && Array.isArray(ev.json?.evidence));
  const evCount = ev.json?.total ?? ev.json?.evidence?.length;
  check("evidence rows present", (ev.json?.total ?? 0) > 0 || (ev.json?.evidence?.length ?? 0) > 0, `total=${evCount}`);

  const intel = await req(`/api/fields/${fid}/intelligence`, {}, token);
  check("GET intelligence", intel.status === 200, `${Object.keys(intel.json ?? {}).join(",")}`);
  const risks = intel.json?.risks?.length ?? 0;
  const anomalies = intel.json?.anomalies?.length ?? 0;
  check("intelligence content", risks > 0 || anomalies > 0, `${risks} risks, ${anomalies} anomalies`);

  const sat = await req(`/api/fields/${fid}/satellite/summary`, {}, token);
  const satSum = sat.json?.summary;
  check("GET satellite summary", sat.status === 200 && satSum, satSum ? `${satSum.total} products, provider ${satSum.provider_status?.status}` : "");

  const twin = await req(`/api/fields/${fid}/digital-twin`, {}, token);
  const tw = twin.json?.twin;
  const layerStates = tw?.layers
    ? Object.entries(tw.layers).map(([k, v]) => `${k}=${v?.state ?? v?.status ?? "?"}`).join(" ")
    : `field=${tw?.field?.name ?? "?"}`;
  check("GET digital-twin", twin.status === 200 && !!tw?.field, layerStates);

  const sensors = await req(`/api/fields/${fid}/devices`, {}, token);
  check("GET devices", sensors.status === 200, `${sensors.json?.devices?.length ?? 0} devices`);

  const sims = await req(`/api/fields/${fid}/simulations`, {}, token);
  check("GET simulations", sims.status === 200, `${sims.json?.simulations?.length ?? 0} simulations`);

  // 4. manual pipeline refresh (the real scheduler path)
  const refresh = await req(`/api/fields/${fid}/refresh`, { method: "POST" }, token);
  check("POST refresh (full pipeline)", refresh.status === 200 && refresh.json?.ok, JSON.stringify(refresh.json ?? {}).slice(0, 160));

  // 5. system
  const prov = await req("/api/providers", {}, token);
  const provList = prov.json?.providers ?? [];
  check("GET providers", prov.status === 200 && provList.length > 0, provList.map((p) => `${p.id ?? p.provider}=${p.health?.status ?? p.status}`).join(" "));
  const jobs = await req("/api/jobs", {}, token);
  check("GET jobs", jobs.status === 200 && (jobs.json?.jobs?.length ?? 0) > 0, `${jobs.json?.jobs?.length ?? 0} job records`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => { console.error("SMOKE ERROR:", e); process.exit(1); });
