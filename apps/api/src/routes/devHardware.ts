/**
 * DEVELOPMENT-ONLY hardware ingestion path — real ESP32 → HTTP → AGRIFUR.
 * ======================================================================
 *
 * Simplest possible path to get REAL physical sensor readings from an ESP32
 * into the AGRIFUR evidence pipeline over plain HTTP (no MQTT broker, no
 * OAuth/session on the device):
 *
 *   ESP32 → Wi-Fi → POST /api/dev/hardware/telemetry → validation →
 *   dedupe → OBSERVED evidence → world model → realtime event → UI
 *
 * The payload uses the flat, human-friendly shape the reference firmware
 * (hardware/esp32/agrifur_esp32_http/) sends:
 *
 *   {
 *     "field_id": "fld_...",                 // the field row id (web app)
 *     "device_id": "AGRIFUR-ESP32-01",       // external id — auto-registered
 *     "temperature_c": 27.4,                 // optional real DHT11 value
 *     "humidity_percent": 61.2,              // optional real DHT11 value
 *     "soil_moisture_raw": 2380,             // optional real ADC (0..4095)
 *     "observed_at": "2026-09-04T10:31:00Z", // optional; backend stamps when absent
 *     "reading_id": "..."                    // optional idempotency key (firmware sends one)
 *   }
 *
 * Every accepted reading flows through the SAME shared ingestion used by the
 * MQTT subscriber and the authenticated HTTPS gateway (ingestValidatedReadings):
 * hard-bound validation → OBSERVED evidence with full provenance → heartbeat →
 * SENSOR_TELEMETRY realtime event → throttled world-model refresh. Nothing is
 * fabricated; nothing lands in a parallel store. sensor_type mapping:
 *   temperature_c      → temperature        (°C, -40..60 hard, -10..50 soft)
 *   humidity_percent   → humidity           (%, 0..100)
 *   soil_moisture_raw  → soil_moisture_raw  (raw ADC 0..4095, uncalibrated —
 *                        stored as-is, never converted to a fake percentage)
 *
 * Guards — this must never become a public write path:
 *   1. The route answers 404 unless DEV_TELEMETRY_ENABLED=1 (opt-in, off by
 *      default in every environment including production).
 *   2. When DEV_TELEMETRY_TOKEN is set, the device must send it in the
 *      `x-device-key` header (simple shared key for a trusted LAN).
 *   3. The target field must exist; a device external id is unique across the
 *      whole system and is bound to exactly one field.
 *   4. Physically impossible values reject the whole message (400).
 */
import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { HttpError, audit, rateLimit, validate } from "../http";
import { newId } from "../util";
import { addMemory } from "../services/memory";
import {
  ingestValidatedReadings,
  maybeRefreshWorldModel,
  parseTimestamp,
  validateReading,
  type ReadingsIn,
} from "../services/telemetry";

const payloadSchema = z
  .object({
    field_id: z.string().min(1).max(120),
    device_id: z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "device_id may only contain letters, digits, dot, dash, underscore"),
    temperature_c: z.number().optional(),
    humidity_percent: z.number().optional(),
    soil_moisture_raw: z.number().optional(),
    observed_at: z.string().max(64).optional(),
    reading_id: z.string().max(120).optional(),
    firmware_version: z.string().max(60).optional(),
  })
  .refine(
    (v) =>
      v.temperature_c !== undefined || v.humidity_percent !== undefined || v.soil_moisture_raw !== undefined,
    { message: "at least one of temperature_c, humidity_percent, soil_moisture_raw is required" },
  );

type DevPayload = z.infer<typeof payloadSchema>;

function enabled(): boolean {
  return process.env.DEV_TELEMETRY_ENABLED === "1";
}

export function devHardwareRoutes(db: AppDb): Router {
  const r = Router();

  r.post("/hardware/telemetry", rateLimit(120, 60_000), (req, res, next) => {
    try {
      if (!enabled()) {
        // Looks absent unless explicitly enabled — never an open path.
        throw new HttpError(404, "NOT_FOUND", "Route not found");
      }
      const token = process.env.DEV_TELEMETRY_TOKEN ?? "";
      if (token !== "") {
        const provided = typeof req.headers["x-device-key"] === "string" ? req.headers["x-device-key"] : "";
        if (provided !== token) {
          throw new HttpError(401, "INVALID_DEVICE_KEY", "Missing or invalid x-device-key header");
        }
      }

      const body = validate(payloadSchema, req.body) as DevPayload;
      const readings: ReadingsIn = [];
      const sensorTypes: string[] = [];
      const unitFor: Record<string, string> = {
        temperature_c: "°C",
        humidity_percent: "%",
        soil_moisture_raw: "raw_adc",
      };
      const typeFor: Record<string, string> = {
        temperature_c: "temperature",
        humidity_percent: "humidity",
        soil_moisture_raw: "soil_moisture_raw",
      };
      for (const fieldName of ["temperature_c", "humidity_percent", "soil_moisture_raw"] as const) {
        const value = body[fieldName];
        if (value === undefined) continue;
        const v = validateReading(typeFor[fieldName], value);
        if (v.verdict === "REJECTED") {
          throw new HttpError(400, "READING_REJECTED", v.reason);
        }
        readings.push({
          sensor_type: typeFor[fieldName],
          value,
          unit: unitFor[fieldName],
          observed_at: body.observed_at ?? undefined,
        });
        sensorTypes.push(typeFor[fieldName]);
      }

      // Field authority: the field must exist. A device external id is unique
      // system-wide and bound to one field; unknown ids are auto-registered on
      // this field (DEVELOPMENT convenience — the endpoint is opt-in).
      const field = db.conn
        .query("SELECT id, name, user_id, farm_id FROM fields WHERE id = ?")
        .get(body.field_id) as { id: string; name: string; user_id: string; farm_id: string } | undefined;
      if (!field) throw new HttpError(404, "FIELD_NOT_FOUND", `Field ${body.field_id} does not exist`);

      const existing = db.conn
        .query("SELECT id, field_id, name, external_id FROM devices WHERE external_id = ?")
        .get(body.device_id) as { id: string; field_id: string; name: string; external_id: string } | undefined;
      let device: { id: string; name: string; external_id: string };
      if (existing) {
        if (existing.field_id !== field.id) {
          throw new HttpError(409, "DEVICE_ON_ANOTHER_FIELD", `Device "${body.device_id}" is registered to a different field — device identity is authoritative`);
        }
        device = { id: existing.id, name: existing.name, external_id: existing.external_id };
      } else {
        const id = newId("dev");
        const meta = {
          registered_via: "dev_http_endpoint",
          note: "DEVELOPMENT ONLY — auto-registered by POST /api/dev/hardware/telemetry. Register devices through the Sensors workspace for production flows.",
        };
        db.conn
          .query("INSERT INTO devices (id, user_id, farm_id, field_id, external_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            field.user_id,
            field.farm_id,
            field.id,
            body.device_id,
            `${body.device_id} (dev HTTP)`,
            "sensor_node",
            body.firmware_version ?? null,
            "registered",
            null,
            JSON.stringify(meta),
            nowIso(),
          );
        audit(db, field.user_id, "device.auto_register_dev", `device:${id}`, { field_id: field.id, external_id: body.device_id });
        addMemory(db, {
          userId: field.user_id,
          farmId: field.farm_id,
          fieldId: field.id,
          kind: "observation",
          title: `Device auto-registered (dev HTTP): ${body.device_id}`,
          summary: `sensor_node registered on field ${field.name} by the DEVELOPMENT HTTP telemetry endpoint.`,
        });
        device = { id, name: `${body.device_id} (dev HTTP)`, external_id: body.device_id };
      }

      // Timestamp sanity: ESP32-provided time is validated (future/too-old are
      // rejected); when absent the backend receive time is used honestly.
      if (body.observed_at !== undefined) {
        const ts = parseTimestamp(body.observed_at);
        if (!ts.ok) throw new HttpError(400, "BAD_TIMESTAMP", ts.reason);
      }
      const received = nowIso();
      const observedAt = body.observed_at ?? received;
      const messageId = body.reading_id ?? `${Date.now()}-${newId("m").slice(-8)}`;

      const res2 = ingestValidatedReadings(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId: field.id,
        device,
        readings,
        transport: "dev_http",
        messageId,
        receivedAt: received,
        firmwareVersion: body.firmware_version ?? null,
      });

      const firstForSensor = sensorTypes.some((st) => {
        const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ? AND sensor_type = ?").get(field.id, st) as { n: number };
        return n.n <= 1;
      });
      maybeRefreshWorldModel(db, field.id, firstForSensor);

      const verdict = res2.inserted === 0 && res2.skippedDuplicates > 0 ? "DUPLICATE" : res2.rejected > 0 ? "PARTIAL" : res2.inserted > 0 ? "VALIDATED" : "EMPTY";
      console.log(
        `[dev-hardware] REAL HARDWARE OBSERVATION RECEIVED ${JSON.stringify({
          device_id: body.device_id,
          device_db_id: device.id,
          field_id: field.id,
          field_name: field.name,
          sensor_types: sensorTypes,
          observed_at: observedAt,
          verdict,
          inserted: res2.inserted,
          skipped_duplicates: res2.skippedDuplicates,
        })}`,
      );

      res.status(res2.inserted > 0 || res2.skippedDuplicates > 0 ? 200 : 400).json({
        ok: res2.inserted > 0,
        verdict,
        inserted: res2.inserted,
        skipped_duplicates: res2.skippedDuplicates,
        rejected: res2.rejected,
        evidence_ids: res2.evidenceIds,
        device_id: body.device_id,
        field_id: field.id,
        sensor_types: sensorTypes,
        observed_at: observedAt,
        note: "Readings stored as OBSERVED physical-sensor evidence (DEVELOPMENT endpoint).",
      });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
