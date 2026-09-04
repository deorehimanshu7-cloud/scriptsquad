// Live verification of the OSM water source + provider health plumbing.
// Usage: node scripts/verify_water.mjs <baseURL>
const base = process.argv[2] || "http://localhost:8787";
const j = (r) => r.json();

async function main() {
  // auth
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "demo@agrifur.dev", password: "agrifur-demo" }),
  }).then(j);
  const token = login.token;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail: detail ?? "" });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  };

  // field
  const fields = await fetch(`${base}/api/fields`, { headers: h }).then(j);
  const field = Array.isArray(fields) ? fields[0] : fields.fields?.[0];
  check("fields list", !!field?.id, field?.name);
  const fid = field.id;

  // world-model water domain state (dual-source)
  const wm = await fetch(`${base}/api/fields/${fid}/world-model`, { headers: h }).then(j);
  const raw = wm.world_model?.snapshot?.domains ?? wm.snapshot?.domains ?? {};
  const doms = Array.isArray(raw)
    ? Object.fromEntries(raw.map((d) => [d.name ?? d.domain ?? d.key ?? "", d]))
    : raw;
  const water = doms.water;
  check("world-model water state", !!water?.state, `state=${water?.state} ${JSON.stringify(water).slice(0, 200)}`);
  const sat = doms.satellite;
  check("world-model satellite state", !!sat?.state, `state=${sat?.state}`);

  // water evidence records
  const ev = await fetch(`${base}/api/fields/${fid}/evidence`, { headers: h }).then(j);
  const rows = ev.evidence ?? ev.rows ?? ev;
  const waterRows = (Array.isArray(rows) ? rows : []).filter((r) => (r.domain ?? r.layer ?? "").toLowerCase().includes("water"));
  check("water evidence rows exist", waterRows.length > 0, `${waterRows.length} water evidence rows`);
  const sample = waterRows[0];
  if (sample) check("water evidence truthful fields", !!(sample.state && sample.provenance), `state=${sample.state} provider=${sample.provider}`);

  // providers health — osm-water AVAILABLE with cleared seed-era error, soilgrids still failing truthfully
  const prov = await fetch(`${base}/api/providers`, { headers: h }).then(j);
  const list = Array.isArray(prov) ? prov : prov.providers ?? prov.health ?? [];
  const list2 = Array.isArray(list) ? list : list.providers ?? list.health ?? [];
  const find = (id) => list2.find((p) => (p.id ?? p.provider ?? "").includes(id));
  const hst = (p) => p?.health?.status ?? p?.state ?? p?.status ?? "";
  const herr = (p) => p?.health?.last_error ?? p?.last_error ?? p?.error ?? "";
  const osm = find("osm-water");
  check("osm-water AVAILABLE", hst(osm) === "AVAILABLE", JSON.stringify(osm?.health ?? osm).slice(0, 200));
  check("osm-water no stale seed error", osm?.health?.last_error == null, "last_error cleared");
  const sg = find("soilgrids");
  check("soilgrids truthful failure", !!sg && /ERROR|UNAVAILABLE|FAILURE|TIMEOUT/i.test(hst(sg) + " " + herr(sg)), `status=${hst(sg)} err=${herr(sg)}`);
  const wri = find("water-india");
  check("water-india still NOT_CONFIGURED", !!wri && /NOT_CONFIGURED/i.test(hst(wri) + ""), `status=${hst(wri)}`);

  // manual refresh still works end to end (runs water step too)
  const job = await fetch(`${base}/api/fields/${fid}/refresh`, { method: "POST", headers: h }).then(j);
  check("refresh ran full pipeline", job?.ok === true && /water/.test(job?.note ?? ""), (job?.note ?? JSON.stringify(job)).slice(0, 180));

  // SPA bundle serves
  const spa = await fetch(`${base}/app/twin`).then((r) => r.status);
  check("SPA twin route 200", spa === 200, `status ${spa}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
