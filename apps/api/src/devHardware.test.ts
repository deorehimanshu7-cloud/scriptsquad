import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./index";
import { nowIso, type AppDb } from "./db";
import { newId } from "./util";

/**
 * DEVELOPMENT HTTP hardware ingestion — POST /api/dev/hardware/telemetry.
 * Real ESP32 → HTTP → same validation/dedupe/evidence/world-model pipeline.
 *
 * Verified end-to-end over a real HTTP server:
 *  1. disabled by default (404) — never an open path
 *  2. enabled: valid real payload → 200, stored as OBSERVED evidence
 *  3. device auto-registered (external id bound to the field)
 *  4. dedupe via reading_id
 *  5. malformed JSON → 400 BAD_JSON
 *  6. non-numeric / missing / impossible values rejected
 *  7. unknown field / device on another field rejected
 *  8. optional shared key (x-device-key) enforced when configured
 *  9. world model refreshed with the real sensor values
 */

const R = { "content-type": "application/json" } as const;

interface ServerCtx {
  app: ReturnType<typeof createApp>["app"];
  db: AppDb;
  server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  base: string;
}

function listen(created: ReturnType<typeof createApp>): Promise<ServerCtx> {
  return new Promise((resolve) => {
    const server = created.app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ app: created.app, db: created.db, server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...R, ...headers };
  return fetch(`${base}${path}`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) });
}

function seedField(db: AppDb, label = "Dev field", deviceExternalId: string | null = null): { userId: string; farmId: string; fieldId: string } {
  const userId = newId("usr");
  const farmId = newId("farm");
  const fieldId = newId("fld");
  db.conn.query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)").run(userId, `${label.replace(/\s+/g, "").toLowerCase()}@dev.test`, "Dev", "x", "farmer", nowIso());
  db.conn.query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(farmId, userId, "Dev farm", null, nowIso(), nowIso());
  const geometry = { type: "Polygon", coordinates: [[[74.0, 20.5], [74.002, 20.5], [74.002, 20.502], [74.0, 20.502], [74.0, 20.5]]] };
  db.conn
    .query("INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(fieldId, farmId, userId, label, null, JSON.stringify(geometry), 20.501, 74.001, JSON.stringify({ min_lon: 74, min_lat: 20.5, max_lon: 74.002, max_lat: 20.502 }), 40000, nowIso(), nowIso());
  if (deviceExternalId) {
    const deviceId = newId("dev");
    db.conn
      .query("INSERT INTO devices (id, user_id, farm_id, field_id, external_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(deviceId, userId, farmId, fieldId, deviceExternalId, "Pre-registered", "sensor_node", "1.0.0", "registered", null, "{}", nowIso());
  }
  return { userId, farmId, fieldId };
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return fn();
}

describe("dev hardware telemetry (HTTP, real server)", () => {
  let ctx: ServerCtx;
  let seedA: { userId: string; farmId: string; fieldId: string };

  beforeAll(async () => {
    process.env.DEV_TELEMETRY_ENABLED = "1";
    delete process.env.DEV_TELEMETRY_TOKEN;
    ctx = await listen(createApp(":memory:"));
    seedA = seedField(ctx.db, "Field A");
  });

  afterAll(() => {
    ctx.server.close();
    delete process.env.DEV_TELEMETRY_ENABLED;
    delete process.env.DEV_TELEMETRY_TOKEN;
  });

  test("1. endpoint is disabled (404) without DEV_TELEMETRY_ENABLED", async () => {
    delete process.env.DEV_TELEMETRY_ENABLED;
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-01", temperature_c: 27.4 });
    expect(res.status).toBe(404);
    process.env.DEV_TELEMETRY_ENABLED = "1";
  });

  test("2. valid real payload → 200, stored, OBSERVED evidence created", async () => {
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", {
      field_id: seedA.fieldId,
      device_id: "AGRIFUR-ESP32-01",
      temperature_c: 27.4,
      humidity_percent: 61.2,
      soil_moisture_raw: 2380,
      firmware_version: "1.1.0-dev-http",
      observed_at: new Date().toISOString(),
      reading_id: `rid-${Date.now()}`,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; verdict: string; inserted: number; evidence_ids: string[]; sensor_types: string[] };
    expect(body.ok).toBe(true);
    expect(body.verdict).toBe("VALIDATED");
    expect(body.inserted).toBe(3);
    expect(body.evidence_ids).toHaveLength(3);
    expect(body.sensor_types.sort()).toEqual(["humidity", "soil_moisture_raw", "temperature"]);
  });

  test("3. rows + evidence are real: observations, device, OBSERVED state", async () => {
    const rows = ctx.db.conn.query("SELECT sensor_type, value, unit, quality, ingestion_id, provenance FROM observations WHERE field_id = ? ORDER BY sensor_type").all(seedA.fieldId) as {
      sensor_type: string;
      value: number;
      unit: string;
      quality: string;
      ingestion_id: string;
      provenance: string;
    }[];
    expect(rows.length).toBe(3);
    const byType = Object.fromEntries(rows.map((r) => [r.sensor_type, r]));
    expect(byType["temperature"]?.value).toBeCloseTo(27.4, 1);
    expect(byType["temperature"]?.unit).toBe("°C");
    expect(byType["humidity"]?.value).toBeCloseTo(61.2, 1);
    expect(byType["soil_moisture_raw"]?.value).toBe(2380);
    expect(byType["soil_moisture_raw"]?.unit).toBe("raw_adc");
    for (const r of rows) {
      expect(r.quality).toBe("high");
      expect(r.provenance).toContain("dev_http");
      expect(r.provenance).toContain("AGRIFUR-ESP32-01");
    }
    const dev = ctx.db.conn.query("SELECT external_id, field_id, status, metadata FROM devices WHERE external_id = ?").get("AGRIFUR-ESP32-01") as { external_id: string; field_id: string; status: string; metadata: string };
    expect(dev.external_id).toBe("AGRIFUR-ESP32-01");
    expect(dev.field_id).toBe(seedA.fieldId);
    expect(dev.status).toBe("online");
    expect(dev.metadata).toContain("dev_http_endpoint");
    const ev = ctx.db.conn.query("SELECT state, domain, sub_type, value FROM evidence WHERE field_id = ? AND sub_type = 'soil_moisture_raw'").get(seedA.fieldId) as { state: string; domain: string; sub_type: string; value: number };
    expect(ev.state).toBe("OBSERVED");
    expect(ev.domain).toBe("sensor");
    expect(ev.value).toBe(2380);
  });

  test("4. world model refreshes with the real sensor values", async () => {
    const ok = await waitFor(() => {
      const snap = ctx.db.conn.query("SELECT snapshot FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT 1").get(seedA.fieldId) as { snapshot: string } | null;
      if (!snap) return false;
      const parsed = JSON.parse(snap.snapshot) as { domains?: { domain: string; entries: { sensor_type: string; max: number }[] }[] };
      const sensor = parsed.domains?.find((d) => d.domain === "sensor");
      return sensor?.entries?.some((e) => e.sensor_type === "temperature") === true;
    });
    expect(ok).toBe(true);
    const snap = ctx.db.conn.query("SELECT snapshot FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT 1").get(seedA.fieldId) as { snapshot: string };
    const parsed = JSON.parse(snap.snapshot) as { domains: { domain: string; entries: { sensor_type: string; max: number; state: string }[] }[] };
    const sensor = parsed.domains.find((d) => d.domain === "sensor")!;
    const temp = sensor.entries.find((e) => e.sensor_type === "temperature")!;
    const raw = sensor.entries.find((e) => e.sensor_type === "soil_moisture_raw")!;
    expect(temp.max).toBeCloseTo(27.4, 1);
    expect(raw.max).toBe(2380);
    expect(temp.state).toBe("OBSERVED");
  });

  test("5. replaying the same reading_id is deduplicated", async () => {
    const payload = {
      field_id: seedA.fieldId,
      device_id: "AGRIFUR-ESP32-01",
      temperature_c: 27.5,
      reading_id: "rid-dup-check",
    };
    const first = await post(ctx.base, "/api/dev/hardware/telemetry", payload);
    expect(first.status).toBe(200);
    const second = await post(ctx.base, "/api/dev/hardware/telemetry", payload);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { inserted: number; skipped_duplicates: number; verdict: string };
    expect(body.inserted).toBe(0);
    expect(body.skipped_duplicates).toBe(1);
    expect(body.verdict).toBe("DUPLICATE");
    const count = ctx.db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE ingestion_id LIKE '%rid-dup-check%'").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("6. malformed JSON → 400 BAD_JSON", async () => {
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", "{not valid json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_JSON");
  });

  test("7. non-numeric / wrong-typed values → 400 VALIDATION", async () => {
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02", temperature_c: "hot" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  test("8. missing field_id / invalid device_id → 400", async () => {
    const noField = await post(ctx.base, "/api/dev/hardware/telemetry", { device_id: "AGRIFUR-ESP32-02", temperature_c: 27 });
    expect(noField.status).toBe(400);
    const badDev = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "bad device!", temperature_c: 27 });
    expect(badDev.status).toBe(400);
    const noSensors = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02" });
    expect(noSensors.status).toBe(400);
  });

  test("9. impossible values reject the whole message (400 READING_REJECTED)", async () => {
    const badHumidity = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02", humidity_percent: 150 });
    expect(badHumidity.status).toBe(400);
    expect(((await badHumidity.json()) as { error: { code: string } }).error.code).toBe("READING_REJECTED");
    const badRaw = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02", soil_moisture_raw: 99999 });
    expect(badRaw.status).toBe(400);
    const badTemp = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02", temperature_c: 500 });
    expect(badTemp.status).toBe(400);
    const count = ctx.db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ? AND device_id IN (SELECT id FROM devices WHERE external_id = 'AGRIFUR-ESP32-02')").get(seedA.fieldId) as { n: number };
    expect(count.n).toBe(0); // nothing stored
  });

  test("10. implausible-but-possible value is SUSPECT, stored flagged (never dropped)", async () => {
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-02", temperature_c: 58 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: string; inserted: number };
    expect(body.verdict).toBe("VALIDATED"); // stored, quality degraded below
    const row = ctx.db.conn.query("SELECT quality FROM observations WHERE field_id = ? AND value = 58").get(seedA.fieldId) as { quality: string };
    expect(row.quality).toBe("medium");
  });

  test("11. unknown field → 404 FIELD_NOT_FOUND", async () => {
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: "fld_nope", device_id: "AGRIFUR-ESP32-03", temperature_c: 27 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("FIELD_NOT_FOUND");
  });

  test("12. future timestamp → 400 BAD_TIMESTAMP", async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-03", temperature_c: 27, observed_at: future });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("BAD_TIMESTAMP");
  });

  test("13. device registered on a different field is rejected (409)", async () => {
    const other = seedField(ctx.db, "Field B", "AGRIFUR-ESP32-CONFLICT");
    const res = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-CONFLICT", temperature_c: 27 });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DEVICE_ON_ANOTHER_FIELD");
    // and posting to its own registered field works
    const ok = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: other.fieldId, device_id: "AGRIFUR-ESP32-CONFLICT", temperature_c: 27 });
    expect(ok.status).toBe(200);
  });

  test("14. shared key is enforced when DEV_TELEMETRY_TOKEN is set", async () => {
    process.env.DEV_TELEMETRY_TOKEN = "dev-lan-key-123";
    const noKey = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-04", temperature_c: 27 });
    expect(noKey.status).toBe(401);
    expect(((await noKey.json()) as { error: { code: string } }).error.code).toBe("INVALID_DEVICE_KEY");
    const wrongKey = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-04", temperature_c: 27 }, { "x-device-key": "wrong" });
    expect(wrongKey.status).toBe(401);
    const withKey = await post(ctx.base, "/api/dev/hardware/telemetry", { field_id: seedA.fieldId, device_id: "AGRIFUR-ESP32-04", temperature_c: 27 }, { "x-device-key": "dev-lan-key-123" });
    expect(withKey.status).toBe(200);
    delete process.env.DEV_TELEMETRY_TOKEN;
  });
});
