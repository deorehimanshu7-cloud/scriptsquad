import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./index";
import { nowIso, type AppDb } from "./db";
import { newId } from "./util";

/**
 * HTTPS hardware gateway — POST /api/hardware/telemetry.
 * Production path for REAL ESP32 data: server-side shared key (no browser
 * session), device registration is authoritative, same shared ingestion
 * (validation → dedupe → OBSERVED evidence → world model) as MQTT/dev-HTTP.
 *
 * Verified over a real HTTP server:
 *  1. health reflects whether the key is configured (never the key itself)
 *  2. unconfigured gateway → 503 (never an open write path)
 *  3. wrong/missing x-device-key → 401
 *  4. valid payload from a REGISTERED device → 200, OBSERVED evidence stored
 *  5. unregistered device → 403 (register in the Sensors workspace first)
 *  6. payload field_id conflicting with the device registration → 409
 *  7. message_id replay is deduplicated
 *  8. impossible readings reject the whole message
 *  9. world model refreshes with the real values
 */

const R = { "content-type": "application/json" } as const;
const KEY = "gateway-test-key-123";

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

function seed(db: AppDb): { userId: string; farmId: string; fieldId: string; deviceExternal: string; deviceDbId: string } {
  const userId = newId("usr");
  const farmId = newId("farm");
  const fieldId = newId("fld");
  const deviceDbId = newId("dev");
  const deviceExternal = "AGRIFUR-ESP32-GW1";
  db.conn.query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)").run(userId, "gw@test.dev", "GW", "x", "farmer", nowIso());
  db.conn.query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(farmId, userId, "GW farm", null, nowIso(), nowIso());
  const geometry = { type: "Polygon", coordinates: [[[74.0, 20.5], [74.002, 20.5], [74.002, 20.502], [74.0, 20.502], [74.0, 20.5]]] };
  db.conn
    .query("INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(fieldId, farmId, userId, "GW field", null, JSON.stringify(geometry), 20.501, 74.001, "{}", 40000, nowIso(), nowIso());
  db.conn
    .query("INSERT INTO devices (id, user_id, farm_id, field_id, external_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(deviceDbId, userId, farmId, fieldId, deviceExternal, "Field Node GW", "sensor_node", "1.1.0", "registered", null, "{}", nowIso());
  return { userId, farmId, fieldId, deviceExternal, deviceDbId };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    device_id: "AGRIFUR-ESP32-GW1",
    message_id: `gw-${newId("m").slice(-8)}`,
    timestamp: new Date().toISOString(),
    firmware_version: "1.1.0",
    readings: { temperature: 27.4, humidity: 61.2, soil_moisture_raw: 2380 },
    ...overrides,
  };
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return fn();
}

describe("hardware gateway (HTTP, real server)", () => {
  let ctx: ServerCtx;
  let s: ReturnType<typeof seed>;

  beforeAll(async () => {
    delete process.env.HARDWARE_GATEWAY_TOKEN;
    ctx = await listen(createApp(":memory:"));
    s = seed(ctx.db);
  });

  afterAll(() => {
    ctx.server.close();
    delete process.env.HARDWARE_GATEWAY_TOKEN;
  });

  test("1. health shows configuration state, never the key", async () => {
    const res = await fetch(`${ctx.base}/api/hardware/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; gateway_configured: boolean };
    expect(body.ok).toBe(true);
    expect(body.gateway_configured).toBe(false);
  });

  test("2. unconfigured gateway answers 503 — never an open write path", async () => {
    const res = await post(ctx.base, "/api/hardware/telemetry", validPayload());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("GATEWAY_NOT_CONFIGURED");
  });

  test("3. configured gateway requires the device key", async () => {
    process.env.HARDWARE_GATEWAY_TOKEN = KEY;
    const missing = await post(ctx.base, "/api/hardware/telemetry", validPayload());
    expect(missing.status).toBe(401);
    const wrong = await post(ctx.base, "/api/hardware/telemetry", validPayload(), { "x-device-key": "nope" });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("INVALID_DEVICE_KEY");
  });

  test("4. valid payload from a registered device → 200, OBSERVED evidence", async () => {
    const res = await post(ctx.base, "/api/hardware/telemetry", validPayload({ message_id: "gw-valid-1" }), { "x-device-key": KEY });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; verdict: string; inserted: number; evidence_ids: string[]; field_id: string };
    expect(body.ok).toBe(true);
    expect(body.verdict).toBe("VALIDATED");
    expect(body.inserted).toBe(3);
    expect(body.evidence_ids).toHaveLength(3);
    expect(body.field_id).toBe(s.fieldId);
    const rows = ctx.db.conn.query("SELECT sensor_type, value, provenance FROM observations WHERE field_id = ? ORDER BY sensor_type").all(s.fieldId) as { sensor_type: string; value: number; provenance: string }[];
    expect(rows.length).toBe(3);
    for (const row of rows) expect(row.provenance).toContain("HTTPS gateway");
    const ev = ctx.db.conn.query("SELECT state FROM evidence WHERE field_id = ? AND sub_type = 'temperature'").get(s.fieldId) as { state: string };
    expect(ev.state).toBe("OBSERVED");
  });

  test("5. unregistered device → 403 with instructions", async () => {
    const res = await post(ctx.base, "/api/hardware/telemetry", validPayload({ device_id: "AGRIFUR-NOT-REGISTERED", message_id: "gw-unknown" }), { "x-device-key": KEY });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DEVICE_NOT_REGISTERED");
  });

  test("6. payload field_id conflicting with registration → 409", async () => {
    const otherField = newId("fld");
    const res = await post(ctx.base, "/api/hardware/telemetry", validPayload({ field_id: otherField, message_id: "gw-fld-1" }), { "x-device-key": KEY });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("DEVICE_FIELD_MISMATCH");
  });

  test("7. message_id replay is deduplicated", async () => {
    const payload = validPayload({ message_id: "gw-dedupe-1", readings: { temperature: 27.5 } });
    const first = await post(ctx.base, "/api/hardware/telemetry", payload, { "x-device-key": KEY });
    expect(first.status).toBe(200);
    const second = await post(ctx.base, "/api/hardware/telemetry", payload, { "x-device-key": KEY });
    expect(second.status).toBe(200);
    const body = (await second.json()) as { verdict: string; inserted: number; skipped_duplicates: number };
    expect(body.verdict).toBe("DUPLICATE");
    expect(body.inserted).toBe(0);
    expect(body.skipped_duplicates).toBe(1);
  });

  test("8. impossible readings reject the whole message (400)", async () => {
    const res = await post(ctx.base, "/api/hardware/telemetry", validPayload({ message_id: "gw-bad-1", readings: { humidity: 150 } }), { "x-device-key": KEY });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("READING_REJECTED");
    const count = ctx.db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE ingestion_id LIKE '%gw-bad-1%'").get() as { n: number };
    expect(count.n).toBe(0);
  });

  test("9. world model refreshes with the real gateway values", async () => {
    await post(ctx.base, "/api/hardware/telemetry", validPayload({ message_id: "gw-wm-1" }), { "x-device-key": KEY });
    const ok = await waitFor(() => {
      const snap = ctx.db.conn.query("SELECT snapshot FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT 1").get(s.fieldId) as { snapshot: string } | null;
      if (!snap) return false;
      const parsed = JSON.parse(snap.snapshot) as { domains?: { domain: string; entries: { sensor_type: string; max: number }[] }[] };
      const sensor = parsed.domains?.find((d) => d.domain === "sensor");
      return sensor?.entries?.some((e) => e.sensor_type === "temperature" && e.max > 0) === true;
    });
    expect(ok).toBe(true);
  });
});
