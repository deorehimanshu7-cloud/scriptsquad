/**
 * Physical telemetry service — the single ingestion path for REAL hardware.
 *
 * Both transports feed this module:
 *   - HTTPS gateway  : POST /api/fields/:id/observations  (auth, rate-limited)
 *   - MQTT subscriber: AGRIFUR/field/{fieldId}/device/{deviceId}/telemetry
 *
 * Every accepted reading is stored in `observations` (full history), promoted
 * to OBSERVED sensor evidence, and pushed to the event bus for realtime UI.
 * Invalid readings are REJECTED (never stored, never become evidence).
 * Readings outside the calibration window but physically plausible are stored
 * as SUSPECT with degraded quality — they still carry the physical OBSERVED
 * state but are explicitly flagged, never presented as clean measurements.
 *
 * Nothing here fabricates values: if a device does not report, there is simply
 * no row, and the device health classification (online/stale/offline) comes
 * from the real last_seen_at.
 */
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { newId, round } from "../util";
import { publishEvent } from "./events";
import { addEvidence } from "./evidence";
import { updateWorldModelAndIntelligence } from "./pipeline";

// ---------------------------------------------------------------------------
// Sensor range knowledge (honest calibration bounds — physical plausibility,
// never "AI" scoring). Hard bounds are physically impossible → REJECTED.
// Soft bounds are implausible-but-possible → SUSPECT (quality medium/low).
// ---------------------------------------------------------------------------
export interface SensorRange {
  unit: string;
  label: string;
  hardMin: number;
  hardMax: number;
  softMin?: number;
  softMax?: number;
}

export const SENSOR_RANGES: Record<string, SensorRange> = {
  soil_moisture: { unit: "%", label: "volumetric soil moisture", hardMin: 0, hardMax: 100 },
  soil_moisture_vwc: { unit: "%", label: "volumetric water content", hardMin: 0, hardMax: 100 },
  // RAW uncalibrated ADC count from a resistive probe (0..4095 on ESP32).
  // Stored as-is — never converted to a percentage because no calibration
  // curve exists for the specific probe + soil.
  soil_moisture_raw: { unit: "raw_adc", label: "raw soil moisture ADC", hardMin: 0, hardMax: 4095 },
  temperature: { unit: "°C", label: "air temperature", hardMin: -40, hardMax: 60, softMin: -10, softMax: 50 },
  air_temperature: { unit: "°C", label: "air temperature", hardMin: -40, hardMax: 60, softMin: -10, softMax: 50 },
  humidity: { unit: "%", label: "relative humidity", hardMin: 0, hardMax: 100 },
  relative_humidity: { unit: "%", label: "relative humidity", hardMin: 0, hardMax: 100 },
  soil_temperature: { unit: "°C", label: "soil temperature", hardMin: -40, hardMax: 70, softMin: -5, softMax: 55 },
  ph: { unit: "pH", label: "soil pH", hardMin: 0, hardMax: 14, softMin: 3.5, softMax: 10.5 },
  ec: { unit: "µS/cm", label: "electrical conductivity", hardMin: 0, hardMax: 100_000, softMax: 20_000 },
  battery_voltage: { unit: "V", label: "battery voltage", hardMin: 0, hardMax: 20 },
  battery_percent: { unit: "%", label: "battery level", hardMin: 0, hardMax: 100 },
  rainfall: { unit: "mm", label: "rainfall", hardMin: 0, hardMax: 500 },
  wind_speed: { unit: "m/s", label: "wind speed", hardMin: 0, hardMax: 60 },
  solar_irradiance: { unit: "W/m²", label: "solar irradiance", hardMin: 0, hardMax: 1500 },
};

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
export type TelemetryVerdict = "VALIDATED" | "SUSPECT" | "REJECTED" | "DUPLICATE";

export interface TelemetryResult {
  verdict: TelemetryVerdict;
  reason: string;
  fieldId: string | null;
  deviceId: string | null;
  inserted: number;
  skippedDuplicates: number;
}

export interface DeviceHealth {
  /** DB-persisted status (registered/online/offline/error) */
  status: string;
  /** computed for the UI — never shows ONLINE forever after disconnect */
  effective_status: "registered" | "online" | "stale" | "offline" | "error";
  last_seen_at: string | null;
  seconds_since_seen: number | null;
}

// ---------------------------------------------------------------------------
// Topic parsing — AGRIFUR/field/{fieldId}/device/{deviceId}/{telemetry|heartbeat}
// ---------------------------------------------------------------------------
export function parseMqttTopic(topic: string, prefix: string): { fieldId: string; deviceId: string; kind: "telemetry" | "heartbeat" } | null {
  const parts = topic.split("/").filter(Boolean);
  // AGRIFUR/field/{fieldId}/device/{deviceId}/{telemetry|heartbeat}
  if (parts.length !== 6) return null;
  const [p, fw, fieldId, dw, deviceId, kindPart] = parts;
  const kind = kindPart as "telemetry" | "heartbeat";
  if (p !== prefix || fw !== "field" || dw !== "device") return null;
  if (kind !== "telemetry" && kind !== "heartbeat") return null;
  if (!fieldId || !deviceId) return null;
  return { fieldId, deviceId, kind };
}

// ---------------------------------------------------------------------------
// Device resolution — server-side authority. The topic field_id is NEVER
// trusted: the device row (registered to a field) decides the field.
// ---------------------------------------------------------------------------
interface ResolvedDevice {
  device_id: string;
  device_external_id: string | null;
  name: string;
  status: string;
  last_seen_at: string | null;
  metadata: Record<string, unknown> | null;
  field_id: string;
  field_name: string;
  user_id: string;
  farm_id: string;
}

export function resolveDeviceByExternalId(db: AppDb, externalId: string): ResolvedDevice | null {
  const row = db.conn
    .query(
      `SELECT d.id AS device_id, d.external_id AS device_external_id, d.name, d.status, d.last_seen_at, d.metadata,
              f.id AS field_id, f.name AS field_name, f.user_id, f.farm_id
       FROM devices d JOIN fields f ON f.id = d.field_id
       WHERE d.external_id = ?`,
    )
    .get(externalId) as unknown as ResolvedDevice | undefined;
  if (!row) return null;
  try {
    row.metadata = row.metadata ? (JSON.parse(String(row.metadata)) as Record<string, unknown>) : null;
  } catch {
    row.metadata = null;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Reading-level validation
// ---------------------------------------------------------------------------
export function validateReading(sensorType: string, value: number): { verdict: "VALIDATED" | "SUSPECT" | "REJECTED"; quality: "high" | "medium" | "low"; reason: string } {
  if (!Number.isFinite(value)) return { verdict: "REJECTED", quality: "low", reason: `value for ${sensorType} is not a finite number` };
  const r = SENSOR_RANGES[sensorType];
  if (!r) {
    return {
      verdict: "VALIDATED",
      quality: "medium",
      reason: `sensor type "${sensorType}" has no calibrated physical range on record — finite value accepted, treat as uncalibrated`,
    };
  }
  if (value < r.hardMin || value > r.hardMax) {
    return {
      verdict: "REJECTED",
      quality: "low",
      reason: `${r.label} ${value} outside physical bounds [${r.hardMin}, ${r.hardMax}] ${r.unit}`,
    };
  }
  if ((r.softMin !== undefined && value < r.softMin) || (r.softMax !== undefined && value > r.softMax)) {
    return {
      verdict: "SUSPECT",
      quality: "medium",
      reason: `${r.label} ${value} ${r.unit} outside the calibration window [${r.softMin ?? "-∞"}, ${r.softMax ?? "∞"}] — stored but flagged`,
    };
  }
  return { verdict: "VALIDATED", quality: "high", reason: "within physical and calibration bounds" };
}

// ---------------------------------------------------------------------------
// Message-level validation
// ---------------------------------------------------------------------------
export interface MqttTelemetryPayload {
  device_id?: unknown;
  field_id?: unknown;
  message_id?: unknown;
  timestamp?: unknown;
  firmware_version?: unknown;
  readings?: unknown;
}

export function parseTimestamp(ts: unknown, now = Date.now()): { ok: true; iso: string } | { ok: false; reason: string } {
  if (ts === undefined || ts === null || ts === "") return { ok: true, iso: nowIso() }; // device clock unset → use received time
  if (typeof ts !== "string" && typeof ts !== "number") return { ok: false, reason: "timestamp must be a string or number" };
  const d = new Date(typeof ts === "number" ? (ts < 1e12 ? ts * 1000 : ts) : ts);
  if (Number.isNaN(d.getTime())) return { ok: false, reason: "timestamp is not a parseable date" };
  const diffMs = d.getTime() - now;
  if (diffMs > 5 * 60_000) return { ok: false, reason: "timestamp is in the future beyond clock skew (device clock likely wrong)" };
  if (diffMs < -90 * 86_400_000) return { ok: false, reason: "timestamp is older than 90 days (device clock reset?)" };
  return { ok: true, iso: d.toISOString() };
}

export type ReadingsIn = { sensor_type: string; value: number; unit?: string | null; ingestion_id?: string; quality?: "high" | "medium" | "low"; observed_at?: string }[];

/** Normalize the canonical firmware payload into the reading list. */
export function normalizeReadings(readings: unknown): { ok: true; list: ReadingsIn } | { ok: false; reason: string } {
  if (!readings || typeof readings !== "object") return { ok: false, reason: "readings missing or not an object" };
  if (Array.isArray(readings)) {
    if (readings.length === 0 || readings.length > 50) return { ok: false, reason: "readings array must have 1..50 entries" };
    const list: ReadingsIn = [];
    for (const r of readings) {
      if (!r || typeof r !== "object") return { ok: false, reason: "reading entry is not an object" };
      const o = r as Record<string, unknown>;
      if (typeof o.sensor_type !== "string" || typeof o.value !== "number") {
        return { ok: false, reason: "each reading needs sensor_type (string) and value (number)" };
      }
      list.push({
        sensor_type: o.sensor_type,
        value: o.value,
        unit: typeof o.unit === "string" ? o.unit : null,
        ingestion_id: typeof o.ingestion_id === "string" ? o.ingestion_id : undefined,
        quality: o.quality === "medium" || o.quality === "low" ? o.quality : undefined,
      });
    }
    return { ok: true, list };
  }
  // object form { sensor_type: value }
  const list: ReadingsIn = [];
  for (const [k, v] of Object.entries(readings as Record<string, unknown>)) {
    if (typeof v !== "number") return { ok: false, reason: `reading "${k}" must be a number` };
    list.push({ sensor_type: k, value: v });
  }
  if (list.length === 0) return { ok: false, reason: "readings object is empty" };
  if (list.length > 50) return { ok: false, reason: "too many readings (max 50)" };
  return { ok: true, list };
}

// ---------------------------------------------------------------------------
// Shared ingestion — one code path for HTTPS and MQTT.
// ---------------------------------------------------------------------------
export interface IngestParams {
  userId: string;
  farmId: string;
  fieldId: string;
  device: { id: string; name: string; external_id: string | null };
  readings: ReadingsIn;
  transport: "https" | "mqtt" | "dev_http";
  messageId?: string;
  receivedAt?: string;
  firmwareVersion?: string | null;
  /** per-reading dedupe key override; defaults to transport-safe composite */
  ingestionKey?: (rd: ReadingsIn[number]) => string;
}

export function ingestValidatedReadings(db: AppDb, p: IngestParams): { inserted: number; skippedDuplicates: number; rejected: number; evidenceIds: string[] } {
  const received = p.receivedAt ?? nowIso();
  const dedupeBase = p.messageId ? `${p.transport}:${p.messageId}` : `${p.transport}:${p.device.id}`;
  let inserted = 0;
  let skippedDuplicates = 0;
  let rejected = 0;
  const evidenceIds: string[] = [];

  for (const rd of p.readings) {
    const key = p.ingestionKey ? p.ingestionKey(rd) : `${dedupeBase}:${rd.sensor_type}`;
    const dup = db.conn.query("SELECT id FROM observations WHERE ingestion_id = ?").get(key);
    if (dup) {
      skippedDuplicates++;
      continue;
    }
    const observedAt = rd.observed_at ?? received;
    const v = validateReading(rd.sensor_type, rd.value);
    // validateReading is re-applied here so a REJECTED reading can never slip
    // through even if a caller skipped the message-level gate.
    if (v.verdict === "REJECTED") {
      rejected++;
      continue;
    }

    const id = newId("obs");
    db.conn
      .query(
        `INSERT INTO observations
         (id, user_id, farm_id, field_id, device_id, sensor_type, value, unit, observed_at, received_at, ingestion_id, quality, calibration_version, firmware_version, provenance, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        p.userId,
        p.farmId,
        p.fieldId,
        p.device.id,
        rd.sensor_type,
        round(rd.value, 4),
        rd.unit ?? SENSOR_RANGES[rd.sensor_type]?.unit ?? null,
        observedAt,
        received,
        key,
        v.quality,
        null,
        p.firmwareVersion ?? null,
        JSON.stringify({
          provider: "sensors",
          device_id: p.device.id,
          device_external_id: p.device.external_id,
          device_name: p.device.name,
          transport: p.transport,
          message_id: p.messageId ?? null,
          validation: v.verdict,
          validation_reason: v.reason,
          dedupe: key,
          note:
            "Physical sensor observation delivered over " +
            (p.transport === "mqtt" ? "MQTT (LAN broker)" : p.transport === "dev_http" ? "DEVELOPMENT HTTP endpoint (LAN)" : "HTTPS gateway") +
            ".",
        }),
        received,
      );

    const ev = addEvidence(db, {
      userId: p.userId,
      farmId: p.farmId,
      fieldId: p.fieldId,
      domain: "sensor",
      source: `Sensor ${p.device.name}`,
      source_type: `sensor:${rd.sensor_type}`,
      sub_type: rd.sensor_type,
      measurement: `Physical sensor reading (${rd.sensor_type})`,
      value: round(rd.value, 4),
      unit: rd.unit ?? SENSOR_RANGES[rd.sensor_type]?.unit ?? null,
      state: "OBSERVED",
      observed_at: observedAt,
      retrieved_at: received,
      quality: v.quality,
      quality_reason: v.reason,
      description:
        v.verdict === "SUSPECT"
          ? `Physical sensor telemetry (OBSERVED) — SUSPECT: ${v.reason}`
          : "Physical sensor telemetry (OBSERVED) promoted from the ingestion stream.",
      provenance: {
        provider: "sensors",
        processing: `telemetry ingestion (${p.transport})`,
        note: `device ${p.device.name} (${p.device.id}) · ${v.reason} · dedupe ${key}`,
      },
    });
    evidenceIds.push(ev.id);
    inserted++;
  }

  // heartbeat — real reception time
  db.conn.query("UPDATE devices SET status = 'online', last_seen_at = ? WHERE id = ?").run(received, p.device.id);

  if (inserted > 0) {
    publishEvent(db, {
      type: "SENSOR_TELEMETRY",
      user_id: p.userId,
      farm_id: p.farmId,
      field_id: p.fieldId,
      payload: {
        device_id: p.device.id,
        device_external_id: p.device.external_id,
        transport: p.transport,
        inserted,
        skipped_duplicates: skippedDuplicates,
        sensor_types: p.readings.map((x) => x.sensor_type),
        evidence_ids: evidenceIds,
      },
    });
  }
  return { inserted, skippedDuplicates, rejected, evidenceIds };
}

// ---------------------------------------------------------------------------
// World-model refresh throttle — recompose immediately on first evidence for a
// sensor type, otherwise at most once per window. Keeps per-packet cost low
// while still propagating real telemetry into the world model + engines.
// ---------------------------------------------------------------------------
const lastWmRun = new Map<string, number>();

export function maybeRefreshWorldModel(db: AppDb, fieldId: string, force = false): void {
  const now = Date.now();
  const last = lastWmRun.get(fieldId) ?? 0;
  const throttleMs = 60_000;
  if (!force && now - last < throttleMs) return;
  lastWmRun.set(fieldId, now);
  void updateWorldModelAndIntelligence(db, fieldId, "SENSOR_TELEMETRY").catch((e) =>
    console.error(`[telemetry] world model update failed for ${fieldId}:`, e),
  );
}

// ---------------------------------------------------------------------------
// MQTT message handler — called by the subscriber for every telemetry message.
// ---------------------------------------------------------------------------
export function handleMqttMessage(db: AppDb, topic: string, raw: string | Buffer, prefix = "AGRIFUR"): TelemetryResult {
  const parsed = parseMqttTopic(topic, prefix);
  if (!parsed) return { verdict: "REJECTED", reason: `topic "${topic}" does not match ${prefix}/field/{fieldId}/device/{deviceId}/telemetry`, fieldId: null, deviceId: null, inserted: 0, skippedDuplicates: 0 };
  if (parsed.kind !== "telemetry") return { verdict: "REJECTED", reason: "not a telemetry topic", fieldId: parsed.fieldId, deviceId: parsed.deviceId, inserted: 0, skippedDuplicates: 0 };

  let payload: MqttTelemetryPayload;
  try {
    payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as MqttTelemetryPayload;
  } catch {
    return { verdict: "REJECTED", reason: "payload is not valid JSON", fieldId: parsed.fieldId, deviceId: parsed.deviceId, inserted: 0, skippedDuplicates: 0 };
  }
  if (typeof payload.device_id !== "string" || payload.device_id === "") {
    return { verdict: "REJECTED", reason: "payload device_id missing", fieldId: parsed.fieldId, deviceId: parsed.deviceId, inserted: 0, skippedDuplicates: 0 };
  }
  // Server-side authority: resolve the device by its external id, then verify
  // the topic field matches the registered field. A mismatch is REJECTED.
  const device = resolveDeviceByExternalId(db, payload.device_id);
  if (!device) {
    return { verdict: "REJECTED", reason: `device "${payload.device_id}" is not registered (register it in the Sensors workspace first)`, fieldId: parsed.fieldId, deviceId: payload.device_id, inserted: 0, skippedDuplicates: 0 };
  }
  if (device.field_id !== parsed.fieldId) {
    return { verdict: "REJECTED", reason: `topic field ${parsed.fieldId} does not match device registration field ${device.field_id} — device identity is authoritative`, fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };
  }
  if (payload.field_id !== undefined && payload.field_id !== null && String(payload.field_id) !== device.field_id) {
    return { verdict: "REJECTED", reason: `payload field_id disagrees with device registration — device identity is authoritative`, fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };
  }

  const ts = parseTimestamp(payload.timestamp);
  if (!ts.ok) return { verdict: "REJECTED", reason: ts.reason, fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };

  const norm = normalizeReadings(payload.readings);
  if (!norm.ok) return { verdict: "REJECTED", reason: norm.reason, fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };

  // per-reading validation → reject the message entirely if any reading is
  // physically impossible (hard bound); SUSPECT readings are kept but flagged.
  let worst: TelemetryVerdict = "VALIDATED";
  const reasons: string[] = [];
  for (const rd of norm.list) {
    const v = validateReading(rd.sensor_type, rd.value);
    if (v.verdict === "REJECTED") {
      return { verdict: "REJECTED", reason: v.reason, fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };
    }
    if (v.verdict === "SUSPECT") worst = "SUSPECT";
    reasons.push(`${rd.sensor_type}: ${v.reason}`);
  }

  const messageId = typeof payload.message_id === "string" ? payload.message_id : `${Date.now()}-${newId("m").slice(-8)}`;
  const observedAt = ts.iso;
  const readingsWithTime: ReadingsIn = norm.list.map((r) => ({ ...r, observed_at: observedAt, unit: r.unit ?? SENSOR_RANGES[r.sensor_type]?.unit ?? null }));

  const res = ingestValidatedReadings(db, {
    userId: device.user_id,
    farmId: device.farm_id,
    fieldId: device.field_id,
    device: { id: device.device_id, name: device.name, external_id: device.device_external_id },
    readings: readingsWithTime,
    transport: "mqtt",
    messageId,
    firmwareVersion: typeof payload.firmware_version === "string" ? payload.firmware_version : null,
  });

  const firstForSensor = norm.list.some((rd) => {
    const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ? AND sensor_type = ?").get(device.field_id, rd.sensor_type) as { n: number };
    return n.n <= 1;
  });
  maybeRefreshWorldModel(db, device.field_id, firstForSensor);

  if (res.inserted === 0 && res.skippedDuplicates > 0) {
    return { verdict: "DUPLICATE", reason: `message ${messageId} already ingested`, fieldId: device.field_id, deviceId: device.device_id, inserted: 0, skippedDuplicates: res.skippedDuplicates };
  }
  return {
    verdict: worst === "SUSPECT" ? "SUSPECT" : "VALIDATED",
    reason: worst === "SUSPECT" ? `stored with SUSPECT flags: ${reasons.join("; ")}` : "validated and stored",
    fieldId: device.field_id,
    deviceId: device.device_id,
    inserted: res.inserted,
    skippedDuplicates: res.skippedDuplicates,
  };
}

// ---------------------------------------------------------------------------
// Heartbeat — real device liveness only. No evidence row is fabricated for a
// heartbeat; it just refreshes last_seen_at and pushes a realtime event.
// ---------------------------------------------------------------------------
export function handleMqttHeartbeat(db: AppDb, topic: string, raw: string | Buffer, prefix = "AGRIFUR"): TelemetryResult {
  const parsed = parseMqttTopic(topic, prefix);
  if (!parsed || parsed.kind !== "heartbeat") return { verdict: "REJECTED", reason: "not a heartbeat topic", fieldId: parsed?.fieldId ?? null, deviceId: parsed?.deviceId ?? null, inserted: 0, skippedDuplicates: 0 };
  let payload: { device_id?: unknown; message_id?: unknown; firmware_version?: unknown } = {};
  try {
    payload = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as { device_id?: unknown; message_id?: unknown; firmware_version?: unknown };
  } catch {
    payload = {};
  }
  const externalId = typeof payload.device_id === "string" && payload.device_id ? payload.device_id : parsed.deviceId;
  const device = resolveDeviceByExternalId(db, externalId);
  if (!device) return { verdict: "REJECTED", reason: `device "${externalId}" is not registered`, fieldId: parsed.fieldId, deviceId: externalId, inserted: 0, skippedDuplicates: 0 };
  if (device.field_id !== parsed.fieldId) return { verdict: "REJECTED", reason: "topic field does not match device registration", fieldId: parsed.fieldId, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };

  const received = nowIso();
  db.conn.query("UPDATE devices SET status = 'online', last_seen_at = ? WHERE id = ?").run(received, device.device_id);
  publishEvent(db, {
    type: "DEVICE_HEARTBEAT",
    user_id: device.user_id,
    farm_id: device.farm_id,
    field_id: device.field_id,
    payload: { device_id: device.device_id, device_external_id: device.device_external_id, received_at: received, firmware_version: typeof payload.firmware_version === "string" ? payload.firmware_version : null },
  });
  return { verdict: "VALIDATED", reason: "heartbeat recorded", fieldId: device.field_id, deviceId: device.device_id, inserted: 0, skippedDuplicates: 0 };
}

// ---------------------------------------------------------------------------
// Device health — ONLINE/STALE/OFFLINE from real last_seen_at. The persisted
// `status` column keeps the DB check constraint; `effective_status` is what the
// UI should show so a device never stays ONLINE forever after disconnecting.
// ---------------------------------------------------------------------------
export function deviceHealth(_db: AppDb, device: { status: string; last_seen_at: string | null; firmware_version?: string | null }): DeviceHealth {
  if (device.status === "error") return { status: "error", effective_status: "error", last_seen_at: device.last_seen_at, seconds_since_seen: null };
  if (!device.last_seen_at) return { status: device.status, effective_status: "registered", last_seen_at: null, seconds_since_seen: null };
  const secs = Math.max(0, Math.round((Date.now() - new Date(device.last_seen_at).getTime()) / 1000));
  if (secs <= 120) return { status: "online", effective_status: "online", last_seen_at: device.last_seen_at, seconds_since_seen: secs };
  if (secs <= 900) return { status: device.status, effective_status: "stale", last_seen_at: device.last_seen_at, seconds_since_seen: secs };
  return { status: "offline", effective_status: "offline", last_seen_at: device.last_seen_at, seconds_since_seen: secs };
}