import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "./index";
import { openDb, nowIso, type AppDb } from "./db";
import { runActionEngine, runContradictionEngine } from "./services/engines";
import { addEvidence } from "./services/evidence";
import { newId } from "./util";

/**
 * Decision-loop tests: risks → recommended actions → taken/verified →
 * farm memory + verifications. Also guards the truthfulness rule that
 * UNKNOWN/LOW risks never produce actions, and that engine contradictions
 * are mirrored into the evidence-relationship graph.
 */

function seedUserFarmField(db: AppDb): { userId: string; farmId: string; fieldId: string } {
  const userId = newId("usr");
  const farmId = newId("farm");
  const fieldId = newId("fld");
  db.conn
    .query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
    .run(userId, `${userId}@test.dev`, "Test", "x", "farmer", nowIso());
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
    .run(fieldId, farmId, userId, "Test field", null, JSON.stringify(geometry), 20.501, 74.001, JSON.stringify({ min_lon: 74, min_lat: 20.5, max_lon: 74.002, max_lat: 20.502 }), 40000, nowIso(), nowIso());
  return { userId, farmId, fieldId };
}

function seedRisk(db: AppDb, fieldId: string, userId: string, farmId: string, level: string, riskType = "water_stress"): string {
  const id = newId("risk");
  db.conn
    .query(
      "INSERT INTO risks (id, user_id, farm_id, field_id, risk_type, level, reason, evidence_ids, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, userId, farmId, fieldId, riskType, level, "test reason", "[]", "open", nowIso(), nowIso());
  return id;
}

describe("action engine (DECISION layer)", () => {
  test("UNKNOWN risk produces NO action — never recommend acting on insufficient evidence", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    seedRisk(db, fieldId, userId, farmId, "UNKNOWN");
    seedRisk(db, fieldId, userId, farmId, "LOW");
    const created = runActionEngine(db, fieldId, []);
    expect(created.length).toBe(0);
    const n = db.conn.query("SELECT COUNT(*) as n FROM actions WHERE field_id=?").get(fieldId) as { n: number };
    expect(n.n).toBe(0);
  });

  test("MEDIUM risk creates an evidence-linked recommended action; re-runs do not duplicate", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    const riskId = seedRisk(db, fieldId, userId, farmId, "MEDIUM");
    const created = runActionEngine(db, fieldId, []);
    expect(created.length).toBe(1);
    const act = db.conn.query("SELECT * FROM actions WHERE field_id=?").get(fieldId) as {
      id: string;
      status: string;
      recommendation_from: string;
      kind: string;
      title: string;
    };
    expect(act.status).toBe("recommended");
    expect(act.recommendation_from).toBe(riskId);
    expect(act.kind).toBe("irrigation");
    expect(act.title.length).toBeGreaterThan(5);
    // re-running the engine must preserve the workflow state (no duplicate recommendations)
    const again = runActionEngine(db, fieldId, []);
    expect(again.length).toBe(0);
    const n = db.conn.query("SELECT COUNT(*) as n FROM actions WHERE field_id=?").get(fieldId) as { n: number };
    expect(n.n).toBe(1);
  });

  test("HIGH heat risk maps to a heat action template", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    seedRisk(db, fieldId, userId, farmId, "HIGH", "heat_stress");
    const created = runActionEngine(db, fieldId, []);
    expect(created.length).toBe(1);
    const act = db.conn.query("SELECT kind, title FROM actions WHERE field_id=?").get(fieldId) as { kind: string; title: string };
    expect(act.kind).toBe("irrigation");
    expect(act.title).toContain("heat");
  });
});

describe("contradiction → evidence-relationship mirror", () => {
  test("an engine contradiction writes a CONTRADICTS row in evidence_relationships", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId } = seedUserFarmField(db);
    // soil moisture sensor evidence (wet) — the state the ingestion route now
    // produces when it promotes telemetry into the evidence layer
    const obs = addEvidence(db, {
      userId,
      farmId,
      fieldId,
      domain: "sensor",
      source: "Sensor test-node",
      source_type: "sensor:soil_moisture",
      sub_type: "soil_moisture",
      measurement: "Physical sensor reading (soil_moisture)",
      value: 45,
      unit: "%",
      state: "OBSERVED",
      observed_at: nowIso(),
      provenance: { provider: "sensors", processing: "telemetry ingestion (HTTPS gateway)" },
    });
    const obsId = obs.id;
    // weather ET0 evidence (deficit > 30 mm in last 7 days)
    const et0 = db.conn
      .query("SELECT id FROM evidence WHERE field_id=? AND domain='weather' LIMIT 1")
      .get(fieldId) as { id: string } | undefined;
    void et0;
    const et0rows: { id: string }[] = [];
    for (let i = 0; i < 7; i++) {
      const id = newId("evid");
      db.conn
        .query(
          `INSERT INTO evidence (id, user_id, farm_id, field_id, domain, source, source_type, sub_type, description, measurement, value, unit, state, quality, quality_reason, observed_at, retrieved_at, geometry, provenance, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, userId, farmId, fieldId, "weather", "Open-Meteo", "open-meteo", "et0_fao_evapotranspiration", null, "ET0", 6, "mm", "DERIVED", "high", null, nowIso(), nowIso(), null, "{}", nowIso());
      et0rows.push({ id });
    }
    const notes: string[] = [];
    const contradictions = runContradictionEngine(db, fieldId, notes);
    expect(contradictions.length).toBeGreaterThan(0);
    const rels = db.conn
      .query("SELECT relationship, evidence_a, evidence_b FROM evidence_relationships WHERE field_id=?")
      .all(fieldId) as { relationship: string; evidence_a: string; evidence_b: string }[];
    expect(rels.some((r) => r.relationship === "CONTRADICTS")).toBe(true);
    expect(rels.some((r) => r.evidence_a === obsId)).toBe(true);
  });
});

describe("action → verification workflow (integration via HTTP)", () => {
  let app: ReturnType<typeof createApp>["app"];
  let server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  let base = "";
  let token = "";
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
    // register + login
    const reg = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "loop@test.dev", name: "Loop", password: "agrifur-demo" }),
    });
    const regJson = (await reg.json()) as { token?: string };
    token = regJson.token ?? "";
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "loop@test.dev", password: "agrifur-demo" }),
    });
    const loginJson = (await login.json()) as { token: string };
    token = loginJson.token;
    // create a field (draw-style polygon)
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const farm = await fetch(`${base}/api/farms`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ name: "Loop farm" }),
    });
    const farmJson = (await farm.json()) as { farm: { id: string } };
    const field = await fetch(`${base}/api/fields`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({
        name: "Loop field",
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
    const fieldJson = (await field.json()) as { field: { id: string } };
    fieldId = fieldJson.field.id;
  });

  afterAll(() => {
    server?.close();
  });

  test("analyze → actions endpoint round-trips through the real API", async () => {
    const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const res = await fetch(`${base}/api/fields/${fieldId}/analyze`, { method: "POST", headers: h });
    const report = (await res.json()) as { report: { actions: number; risks: number } };
    expect(res.status).toBe(200);
    expect(typeof report.report.actions).toBe("number");
    // actions list should return at least what the engine created (may be 0 if no real evidence)
    const actions = await fetch(`${base}/api/fields/${fieldId}/actions`, { headers: h });
    const actionsJson = (await actions.json()) as { actions: { id: string; status: string }[] };
    expect(Array.isArray(actionsJson.actions)).toBe(true);
  });
});