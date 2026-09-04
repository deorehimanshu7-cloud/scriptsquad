import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./index";
import { openDb, nowIso, type AppDb } from "./db";
import { classifyFreshness, questionFocus, buildAiContext, FOCUS_DOMAINS, type AiFocus } from "./services/aiContext";
import { newId } from "./util";

/**
 * AI-context tests:
 *  1. freshness classifier thresholds (never call stale data "live")
 *  2. question → evidence-focus routing (en/hi/mr)
 *  3. ai-context honesty: unavailable domains stay NO_DATA/UNKNOWN, never fabricated
 *  4. sensor telemetry appears as OBSERVED with freshness + provenance
 *  5. field isolation: another user gets 403 on the ai-context endpoint
 */

function seedUserFarmField(db: AppDb, email = "ctx@test.dev"): { userId: string; farmId: string; fieldId: string } {
  const userId = newId("usr");
  const farmId = newId("farm");
  const fieldId = newId("fld");
  db.conn
    .query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
    .run(userId, email, "Test", "x", "farmer", nowIso());
  db.conn
    .query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(farmId, userId, "Test farm", null, nowIso(), nowIso());
  const geometry = {
    type: "Polygon",
    coordinates: [
      [
        [74.0, 20.5],
        [74.002, 20.5],
        [74.002, 20.502],
        [74.0, 20.502],
        [74.0, 20.5],
      ],
    ],
  };
  db.conn
    .query(
      `INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(fieldId, farmId, userId, "Test field", "soybean", JSON.stringify(geometry), 20.501, 74.001, JSON.stringify({ min_lon: 74, min_lat: 20.5, max_lon: 74.002, max_lat: 20.502 }), 40000, nowIso(), nowIso());
  return { userId, farmId, fieldId };
}

describe("sensor freshness classifier", () => {
  const now = new Date("2026-09-04T12:00:00Z");
  test("fresh observation < 15 min is LIVE", () => {
    expect(classifyFreshness(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe("LIVE");
  });
  test("30 min old is RECENT, 3 h old is STALE, 2 days old is OFFLINE", () => {
    expect(classifyFreshness(new Date(now.getTime() - 30 * 60_000).toISOString(), now)).toBe("RECENT");
    expect(classifyFreshness(new Date(now.getTime() - 3 * 3600_000).toISOString(), now)).toBe("STALE");
    expect(classifyFreshness(new Date(now.getTime() - 2 * 24 * 3600_000).toISOString(), now)).toBe("OFFLINE");
  });
  test("missing or future timestamp is UNKNOWN, not LIVE", () => {
    expect(classifyFreshness(null, now)).toBe("UNKNOWN");
    expect(classifyFreshness(new Date(now.getTime() + 60_000).toISOString(), now)).toBe("UNKNOWN");
  });
});

describe("question → focus routing", () => {
  test("moisture question routes to sensors", () => {
    expect(questionFocus("माझ्या शेतात आत्ता ओलावा किती आहे?")).toBe("sensors");
  });
  test("irrigation question routes to water", () => {
    expect(questionFocus("सिंचन करावे का?")).toBe("water");
  });
  test("stress question routes to crop", () => {
    expect(questionFocus("पिकाला ताण का दिसतोय?")).toBe("crop");
  });
  test("change question routes to satellite", () => {
    expect(questionFocus("माझ्या शेतात काय बदलले?")).toBe("satellite");
  });
  test("English weather question routes to weather", () => {
    expect(questionFocus("What is the weather forecast for rain?")).toBe("weather");
  });
  test("unmatched question falls back to all", () => {
    expect(questionFocus("hello")).toBe("all");
  });
  test("every named focus has a domain mapping", () => {
    for (const f of ["sensors", "satellite", "weather", "soil", "water", "terrain", "crop", "intelligence"] as AiFocus[]) {
      expect((FOCUS_DOMAINS as Record<string, string[]>)[f].length).toBeGreaterThan(0);
    }
  });
});

describe("ai-context honesty", () => {
  test("empty field reports NO_DATA/UNKNOWN honestly — nothing fabricated", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    const ctx = buildAiContext(db, fieldId);
    expect(ctx.sensors.state).toBe("NO_DATA");
    expect(ctx.sensors.reason).toContain("No sensor devices");
    expect(ctx.satellite.state).toBe("NO_DATA");
    expect(ctx.soil.state).toBe("NO_DATA");
    expect(ctx.weather.state).toBe("NO_DATA");
    expect(ctx.field.crop_name).toBe("soybean");
    expect(ctx.intelligence.risks.length).toBe(0);
    expect(ctx.provenance.field_id).toBe(fieldId);
    void userId;
    void farmId;
  });

  test("fresh device telemetry shows OBSERVED with LIVE freshness and provenance", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    const deviceId = newId("dev");
    db.conn
      .query("INSERT INTO devices (id, user_id, farm_id, field_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(deviceId, userId, farmId, fieldId, "ESP32-01", "sensor_node", "1.0", "online", nowIso(), "{}", nowIso());
    db.conn
      .query(
        "INSERT INTO observations (id, user_id, farm_id, field_id, device_id, sensor_type, value, unit, observed_at, received_at, ingestion_id, quality, calibration_version, firmware_version, provenance, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(newId("obs"), userId, farmId, fieldId, deviceId, "soil_moisture", 31.5, "%", nowIso(), nowIso(), "ing-1", "VALID", "1.0", "1.0", JSON.stringify({ device: "ESP32-01", path: "POST /devices/:id/telemetry" }), nowIso());
    const ctx = buildAiContext(db, fieldId);
    expect(ctx.sensors.state).toBe("LIVE");
    expect(ctx.sensors.observations.length).toBe(1);
    const obs = ctx.sensors.observations[0] as Record<string, unknown>;
    expect(obs.sensor_type).toBe("soil_moisture");
    expect(obs.value).toBe(31.5);
    expect(obs.state).toBe("OBSERVED");
    expect(obs.freshness).toBe("LIVE");
    expect(obs.quality).toBe("VALID");
    // stale sensor must never present itself as live
    db.conn
      .query("UPDATE observations SET observed_at = ? WHERE field_id = ?")
      .run(new Date(Date.now() - 3 * 3600_000).toISOString(), fieldId);
    const ctx2 = buildAiContext(db, fieldId);
    expect(ctx2.sensors.state).toBe("STALE");
    expect(ctx2.sensors.reason).toContain("not currently reporting");
  });
});

describe("ai-context endpoint (HTTP)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  let base = "";
  let tokenA = "";
  let tokenB = "";
  let fieldId = "";

  beforeAll(async () => {
    const created = createApp(":memory:");
    app = created.app;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        resolve();
      });
    });
    const regA = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@ctx.dev", name: "Alice", password: "agrifur-demo" }),
    });
    tokenA = ((await regA.json()) as { token: string }).token;
    const regB = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "b@ctx.dev", name: "Bob", password: "agrifur-demo" }),
    });
    tokenB = ((await regB.json()) as { token: string }).token;
    const h = { authorization: `Bearer ${tokenA}`, "content-type": "application/json" };
    const farm = await fetch(`${base}/api/farms`, { method: "POST", headers: h, body: JSON.stringify({ name: "Ctx farm" }) });
    const farmJson = (await farm.json()) as { farm: { id: string } };
    const field = await fetch(`${base}/api/fields`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        name: "Ctx field",
        farm_id: farmJson.farm.id,
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [74.0, 20.5],
              [74.002, 20.5],
              [74.002, 20.502],
              [74.0, 20.502],
              [74.0, 20.5],
            ],
          ],
        },
      }),
    });
    fieldId = ((await field.json()) as { field: { id: string } }).field.id;
  });

  afterAll(() => {
    server?.close();
  });

  test("GET /api/fields/:id/ai-context returns honest sections for a fresh field", async () => {
    const res = await fetch(`${base}/api/fields/${fieldId}/ai-context`, { headers: { authorization: `Bearer ${tokenA}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ai_context: { sensors: { state: string }; satellite: { state: string }; soil: { state: string }; focus: string; provenance: { field_id: string } } };
    expect(body.ai_context.sensors.state).toBe("NO_DATA");
    expect(body.ai_context.satellite.state).toBe("NO_DATA");
    expect(body.ai_context.soil.state).toBe("NO_DATA");
    expect(body.ai_context.focus).toBe("all");
    expect(body.ai_context.provenance.field_id).toBe(fieldId);
  });

  test("focus query parameter is echoed (question-dependent retrieval)", async () => {
    const res = await fetch(`${base}/api/fields/${fieldId}/ai-context?focus=sensors`, { headers: { authorization: `Bearer ${tokenA}` } });
    const body = (await res.json()) as { ai_context: { focus: string } };
    expect(body.ai_context.focus).toBe("sensors");
  });

  test("field isolation: another user's request is rejected with 403", async () => {
    const res = await fetch(`${base}/api/fields/${fieldId}/ai-context`, { headers: { authorization: `Bearer ${tokenB}` } });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("unauthenticated request is rejected", async () => {
    const res = await fetch(`${base}/api/fields/${fieldId}/ai-context`);
    expect(res.status).toBe(401);
  });
});