import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import mqtt, { type MqttClient } from "mqtt";
import { Aedes } from "aedes";
import { openDb, nowIso, type AppDb } from "./db";
import { newId } from "./util";
import { parseMqttTopic, handleMqttMessage, handleMqttHeartbeat, validateReading, parseTimestamp, normalizeReadings, deviceHealth } from "./services/telemetry";
import { startMqttSubscriber } from "./services/mqtt";
import { buildAiContext } from "./services/aiContext";

/**
 * Physical telemetry tests.
 *  - topic parsing + reading validation verdicts (hard REJECT / soft SUSPECT)
 *  - full message pipeline: valid, duplicate, unknown device, wrong field,
 *    bad timestamp, out-of-range, suspect, heartbeat, evidence, AI context
 *  - a REAL MQTT round-trip against an in-process Aedes broker (real MQTT
 *    connect/publish/subscribe over TCP, no simulation of the transport)
 */

function seed(db: AppDb, email = "mqtt@test.dev"): { userId: string; farmId: string; fieldId: string; deviceId: string } {
  const userId = newId("usr");
  const farmId = newId("farm");
  const fieldId = newId("fld");
  const deviceId = newId("dev");
  db.conn.query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)").run(userId, email, "Test", "x", "farmer", nowIso());
  db.conn.query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(farmId, userId, "Test farm", null, nowIso(), nowIso());
  const geometry = { type: "Polygon", coordinates: [[[74.0, 20.5], [74.002, 20.5], [74.002, 20.502], [74.0, 20.502], [74.0, 20.5]]] };
  db.conn
    .query("INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(fieldId, farmId, userId, "Test field", null, JSON.stringify(geometry), 20.501, 74.001, JSON.stringify({ min_lon: 74, min_lat: 20.5, max_lon: 74.002, max_lat: 20.502 }), 40000, nowIso(), nowIso());
  db.conn
    .query("INSERT INTO devices (id, user_id, farm_id, field_id, external_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(deviceId, userId, farmId, fieldId, "AGRIFUR-ESP32-001", "Field Node-01", "sensor_node", "1.0.0", "registered", null, "{}", nowIso());
  return { userId, farmId, fieldId, deviceId };
}

const topic = (fieldId: string) => `AGRIFUR/field/${fieldId}/device/AGRIFUR-ESP32-001/telemetry`;
const heartbeatTopic = (fieldId: string) => `AGRIFUR/field/${fieldId}/device/AGRIFUR-ESP32-001/heartbeat`;

function validPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    device_id: "AGRIFUR-ESP32-001",
    message_id: `msg-${newId("m").slice(-8)}`,
    timestamp: new Date().toISOString(),
    firmware_version: "1.0.0",
    readings: { soil_moisture: 42.7, temperature: 28.4, humidity: 67.2 },
    ...overrides,
  });
}

describe("topic parsing", () => {
  test("valid telemetry and heartbeat topics parse", () => {
    expect(parseMqttTopic("AGRIFUR/field/fld_1/device/AGRIFUR-ESP32-001/telemetry", "AGRIFUR")).toEqual({ fieldId: "fld_1", deviceId: "AGRIFUR-ESP32-001", kind: "telemetry" });
    expect(parseMqttTopic("AGRIFUR/field/fld_1/device/AGRIFUR-ESP32-001/heartbeat", "AGRIFUR")?.kind).toBe("heartbeat");
  });
  test("wrong prefix / wrong shape / wrong kind are rejected", () => {
    expect(parseMqttTopic("OTHER/field/fld_1/device/dev/telemetry", "AGRIFUR")).toBeNull();
    expect(parseMqttTopic("AGRIFUR/fld/dev/telemetry", "AGRIFUR")).toBeNull();
    expect(parseMqttTopic("AGRIFUR/field/fld_1/device/dev/status", "AGRIFUR")).toBeNull();
  });
});

describe("reading validation verdicts", () => {
  test("in-range values are VALIDATED high", () => {
    expect(validateReading("soil_moisture", 42.7).verdict).toBe("VALIDATED");
    expect(validateReading("soil_moisture", 42.7).quality).toBe("high");
  });
  test("physically impossible values are REJECTED", () => {
    expect(validateReading("soil_moisture", 150).verdict).toBe("REJECTED");
    expect(validateReading("humidity", -5).verdict).toBe("REJECTED");
    expect(validateReading("temperature", 500).verdict).toBe("REJECTED");
  });
  test("implausible-but-possible values are SUSPECT with medium quality", () => {
    expect(validateReading("temperature", 58).verdict).toBe("SUSPECT");
    expect(validateReading("temperature", 58).quality).toBe("medium");
  });
  test("non-finite values are REJECTED", () => {
    expect(validateReading("soil_moisture", Number.NaN).verdict).toBe("REJECTED");
    expect(validateReading("soil_moisture", Number.POSITIVE_INFINITY).verdict).toBe("REJECTED");
  });
  test("unknown sensor type with finite value is accepted but flagged uncalibrated", () => {
    const r = validateReading("mystery_sensor", 5);
    expect(r.verdict).toBe("VALIDATED");
    expect(r.quality).toBe("medium");
  });
});

describe("timestamp validation", () => {
  test("missing timestamp falls back to received time", () => {
    const r = parseTimestamp(undefined);
    expect(r.ok).toBe(true);
  });
  test("future beyond skew is REJECTED", () => {
    const r = parseTimestamp(new Date(Date.now() + 60 * 60_000).toISOString());
    expect(r.ok).toBe(false);
  });
  test("older than 90 days is REJECTED (clock reset)", () => {
    const r = parseTimestamp(new Date(Date.now() - 100 * 86_400_000).toISOString());
    expect(r.ok).toBe(false);
  });
  test("garbage string is REJECTED", () => {
    expect(parseTimestamp("not-a-date").ok).toBe(false);
  });
});

describe("MQTT telemetry message pipeline", () => {
  test("valid message → VALIDATED, stored OBSERVED, device online, evidence + realtime event + AI context", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId, deviceId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload());
    expect(r.verdict).toBe("VALIDATED");
    expect(r.inserted).toBe(3);
    expect(r.fieldId).toBe(fieldId);

    const obs = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number };
    expect(obs.n).toBe(3);
    const ev = db.conn.query("SELECT COUNT(*) AS n FROM evidence WHERE field_id = ? AND domain='sensor' AND state='OBSERVED'").get(fieldId) as { n: number };
    expect(ev.n).toBe(3);
    const dev = db.conn.query("SELECT status, last_seen_at FROM devices WHERE id = ?").get(deviceId) as { status: string; last_seen_at: string | null };
    expect(dev.status).toBe("online");
    expect(dev.last_seen_at).not.toBeNull();
    const event = db.conn.query("SELECT COUNT(*) AS n FROM events WHERE type='SENSOR_TELEMETRY' AND field_id = ?").get(fieldId) as { n: number };
    expect(event.n).toBeGreaterThanOrEqual(1);
    // world model sensor domain reflects the real telemetry
    const wm = db.conn.query("SELECT snapshot FROM world_model_states WHERE field_id = ? ORDER BY created_at DESC LIMIT 1").get(fieldId) as { snapshot: string } | null;
    if (wm) {
      const snap = JSON.parse(wm.snapshot) as { domains?: { domain: string; count: number; state: string }[] };
      const sensor = snap.domains?.find((d) => d.domain === "sensor");
      expect(sensor?.count).toBe(3);
    }
    // AI context contains the real reading as OBSERVED/LIVE
    const ctx = buildAiContext(db, fieldId);
    expect(ctx.sensors.state).toBe("LIVE");
    const moisture = ctx.sensors.observations.find((o) => o.sensor_type === "soil_moisture") as Record<string, unknown> | undefined;
    expect(moisture).toBeDefined();
    expect(moisture?.value).toBe(42.7);
    expect(moisture?.state).toBe("OBSERVED");
    void userId;
    void farmId;
  });

  test("duplicate message_id → DUPLICATE, no second row", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const payload = validPayload({ message_id: "fixed-msg-1" });
    const r1 = handleMqttMessage(db, topic(fieldId), payload);
    expect(r1.verdict).toBe("VALIDATED");
    const r2 = handleMqttMessage(db, topic(fieldId), payload);
    expect(r2.verdict).toBe("DUPLICATE");
    const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number };
    expect(n.n).toBe(3);
  });

  test("unknown device → REJECTED, nothing stored", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload({ device_id: "AGRIFUR-ESP32-999" }));
    expect(r.verdict).toBe("REJECTED");
    expect(r.reason).toContain("not registered");
    const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number };
    expect(n.n).toBe(0);
  });

  test("topic field ≠ registered field → REJECTED (device identity is authoritative)", () => {
    const db = openDb(":memory:");
    seed(db);
    const r = handleMqttMessage(db, topic("fld_someone_elses"), validPayload());
    expect(r.verdict).toBe("REJECTED");
    expect(r.reason).toContain("does not match device registration");
  });

  test("payload field_id disagreeing with registration → REJECTED", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload({ field_id: "fld_other" }));
    expect(r.verdict).toBe("REJECTED");
  });

  test("future timestamp → REJECTED", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload({ timestamp: new Date(Date.now() + 60 * 60_000).toISOString() }));
    expect(r.verdict).toBe("REJECTED");
    expect(r.reason).toContain("future");
  });

  test("hard out-of-range value → REJECTED, nothing stored", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload({ readings: { soil_moisture: 150 } }));
    expect(r.verdict).toBe("REJECTED");
    const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number };
    expect(n.n).toBe(0);
  });

  test("soft out-of-window value → SUSPECT but stored with medium quality", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), validPayload({ readings: { temperature: 58 } }));
    expect(r.verdict).toBe("SUSPECT");
    const row = db.conn.query("SELECT quality FROM observations WHERE field_id = ? AND sensor_type='temperature'").get(fieldId) as { quality: string } | null;
    expect(row?.quality).toBe("medium");
    const ev = db.conn.query("SELECT quality, quality_reason FROM evidence WHERE field_id = ? AND sub_type='temperature'").get(fieldId) as { quality: string; quality_reason: string } | null;
    expect(ev?.quality).toBe("medium");
    expect(ev?.quality_reason).toContain("calibration window");
  });

  test("non-JSON payload → REJECTED", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttMessage(db, topic(fieldId), "not json at all");
    expect(r.verdict).toBe("REJECTED");
  });
});

describe("MQTT heartbeat", () => {
  test("heartbeat refreshes liveness, emits DEVICE_HEARTBEAT, creates no evidence", () => {
    const db = openDb(":memory:");
    const { userId, farmId, fieldId, deviceId } = seed(db);
    const r = handleMqttHeartbeat(db, heartbeatTopic(fieldId), JSON.stringify({ device_id: "AGRIFUR-ESP32-001", firmware_version: "1.0.0" }));
    expect(r.verdict).toBe("VALIDATED");
    const dev = db.conn.query("SELECT status, last_seen_at FROM devices WHERE id = ?").get(deviceId) as { status: string; last_seen_at: string | null };
    expect(dev.status).toBe("online");
    expect(dev.last_seen_at).not.toBeNull();
    const ev = db.conn.query("SELECT COUNT(*) AS n FROM evidence WHERE field_id = ?").get(fieldId) as { n: number };
    expect(ev.n).toBe(0);
    const evt = db.conn.query("SELECT COUNT(*) AS n FROM events WHERE type='DEVICE_HEARTBEAT'").get() as { n: number };
    expect(evt.n).toBe(1);
    void userId;
    void farmId;
  });

  test("unknown device heartbeat → REJECTED", () => {
    const db = openDb(":memory:");
    const { fieldId } = seed(db);
    const r = handleMqttHeartbeat(db, `AGRIFUR/field/${fieldId}/device/AGRIFUR-ESP32-999/heartbeat`, JSON.stringify({ device_id: "AGRIFUR-ESP32-999" }));
    expect(r.verdict).toBe("REJECTED");
  });
});

describe("device health classification (no fake ONLINE)", () => {
  test("never-seen device is registered/WAITING_FOR_TELEMETRY", () => {
    const h = deviceHealth(openDb(":memory:"), { status: "registered", last_seen_at: null });
    expect(h.effective_status).toBe("registered");
  });
  test("fresh last_seen → online; 5 min → stale; 2 h → offline", () => {
    const now = Date.now();
    expect(deviceHealth(openDb(":memory:"), { status: "online", last_seen_at: new Date(now - 30_000).toISOString() }).effective_status).toBe("online");
    expect(deviceHealth(openDb(":memory:"), { status: "online", last_seen_at: new Date(now - 5 * 60_000).toISOString() }).effective_status).toBe("stale");
    expect(deviceHealth(openDb(":memory:"), { status: "online", last_seen_at: new Date(now - 2 * 3600_000).toISOString() }).effective_status).toBe("offline");
  });
  test("error status is never masked", () => {
    expect(deviceHealth(openDb(":memory:"), { status: "error", last_seen_at: new Date().toISOString() }).effective_status).toBe("error");
  });
});

describe("normalizeReadings", () => {
  test("object form and array form both normalize", () => {
    expect(normalizeReadings({ soil_moisture: 30 }).ok).toBe(true);
    const arr = normalizeReadings([{ sensor_type: "temperature", value: 25 }]);
    expect(arr.ok).toBe(true);
    if (arr.ok) expect(arr.list[0]?.sensor_type).toBe("temperature");
  });
  test("non-numeric reading is rejected", () => {
    expect(normalizeReadings({ soil_moisture: "wet" }).ok).toBe(false);
    expect(normalizeReadings(42).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// REAL MQTT round-trip — in-process Aedes broker over TCP, real mqtt client,
// the actual startMqttSubscriber + telemetry pipeline. No transport mocking.
// ---------------------------------------------------------------------------
describe("real MQTT round-trip (Aedes broker)", () => {
  let db: AppDb;
  let fieldId = "";
  let aedes: Aedes;
  let broker: Server;
  let port = 0;
  let sub: ReturnType<typeof startMqttSubscriber>;
  let pub: MqttClient;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    db = openDb(":memory:");
    ({ fieldId } = seed(db));
    aedes = new Aedes();
    await aedes.listen(); // opens the broker (v1 requirement)
    broker = createServer(aedes.handle);
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", () => resolve()));
    port = (broker.address() as { port: number }).port;

    sub = startMqttSubscriber(db, { brokerUrl: `mqtt://127.0.0.1:${port}`, enabled: true, reconnectPeriodMs: 500, connectTimeoutMs: 2000, topicPrefix: "AGRIFUR" });

    // wait until the subscriber is connected + subscribed
    let connected = false;
    for (let i = 0; i < 50 && !connected; i++) {
      await sleep(100);
      const row = db.conn.query("SELECT status FROM provider_health WHERE provider='mqtt-broker'").get() as { status: string } | undefined;
      connected = row?.status === "AVAILABLE";
    }
    if (!connected) throw new Error("subscriber never connected to test broker");

    pub = mqtt.connect(`mqtt://127.0.0.1:${port}`, { clientId: "test-pub" });
    await new Promise<void>((resolve, reject) => {
      pub.on("connect", () => resolve());
      pub.on("error", reject);
    });
  });

  afterAll(() => {
    try {
      pub?.end(true);
    } catch {
      /* noop */
    }
    try {
      sub?.stop();
    } catch {
      /* noop */
    }
    try {
      broker?.close();
    } catch {
      /* noop */
    }
    try {
      aedes?.close();
    } catch {
      /* noop */
    }
    db?.conn.close();
  });

  test("publish → subscriber ingests real reading end to end", async () => {
    pub.publish(topic(fieldId), validPayload({ message_id: "roundtrip-1" }), { qos: 1 });
    let n = 0;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      n = (db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number }).n;
      if (n >= 3) break;
    }
    expect(n).toBe(3);
    const dev = db.conn.query("SELECT status FROM devices WHERE external_id='AGRIFUR-ESP32-001'").get() as { status: string };
    expect(dev.status).toBe("online");
    const ev = db.conn.query("SELECT COUNT(*) AS n FROM evidence WHERE field_id = ? AND domain='sensor' AND state='OBSERVED'").get(fieldId) as { n: number };
    expect(ev.n).toBeGreaterThanOrEqual(3);
    const ctx = buildAiContext(db, fieldId);
    expect(ctx.sensors.state).toBe("LIVE");
    expect(ctx.sensors.observations.some((o) => o.sensor_type === "soil_moisture" && o.value === 42.7)).toBe(true);
  });

  test("duplicate over the wire → DUPLICATE, still 3 rows", async () => {
    pub.publish(topic(fieldId), JSON.stringify({ device_id: "AGRIFUR-ESP32-001", message_id: "roundtrip-1", timestamp: new Date().toISOString(), firmware_version: "1.0.0", readings: { soil_moisture: 42.7, temperature: 28.4, humidity: 67.2 } }), { qos: 1 });
    await sleep(400);
    const n = (db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number }).n;
    expect(n).toBe(3);
  });

  test("heartbeat over the wire updates liveness", async () => {
    pub.publish(heartbeatTopic(fieldId), JSON.stringify({ device_id: "AGRIFUR-ESP32-001", firmware_version: "1.0.0" }), { qos: 1 });
    await sleep(400);
    const evt = db.conn.query("SELECT COUNT(*) AS n FROM events WHERE type='DEVICE_HEARTBEAT'").get() as { n: number };
    expect(evt.n).toBeGreaterThanOrEqual(1);
  });

  test("unregistered device over the wire is REJECTED and never stored", async () => {
    const before = (db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number }).n;
    pub.publish(`AGRIFUR/field/${fieldId}/device/AGRIFUR-ESP32-999/telemetry`, validPayload({ device_id: "AGRIFUR-ESP32-999" }), { qos: 1 });
    await sleep(400);
    const after = (db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ?").get(fieldId) as { n: number }).n;
    expect(after).toBe(before);
  });
});