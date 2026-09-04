/**
 * Hardware gateway — REAL ESP32 telemetry over HTTPS (production path).
 * =====================================================================
 *
 * Purpose: let a physical ESP32 (or any field device) push real sensor
 * readings to AGRIFUR from anywhere — public internet, not just the LAN dev
 * path. TLS is provided by the public HTTPS endpoint the API is served behind
 * (reverse proxy / host TLS); this route itself never runs plaintext-only —
 * operators must never expose it over unencrypted public transport.
 *
 * POST /api/hardware/telemetry
 *   headers: content-type: application/json
 *            x-device-key: <HARDWARE_GATEWAY_TOKEN>   (server-side secret)
 *   body (canonical firmware shape, same as the MQTT subscriber):
 *     {
 *       "device_id": "AGRIFUR-ESP32-01",   // external id — must be registered
 *       "message_id": "169...-00042",       // optional → dedupe
 *       "timestamp": "2026-09-04T10:31:00Z",// optional; backend stamps when absent
 *       "firmware_version": "1.1.0",
 *       "readings": { "temperature": 27.4, "soil_moisture_raw": 2380 }  // or array form
 *     }
 *
 * Security model:
 *   - No browser session on the device. One server-side shared key
 *     (HARDWARE_GATEWAY_TOKEN) is required; without it the route answers
 *     503 GATEWAY_NOT_CONFIGURED, so an unconfigured host is never an open
 *     write path.
 *   - The device external id must already be registered to a field (Sensors
 *     workspace, POST /api/fields/:id/devices). The registration decides the
 *     field — the payload field_id is never trusted (mirrors MQTT).
 *   - Every reading goes through the SAME shared ingestion as MQTT/dev-HTTP:
 *     physical-range validation (impossible → 400 READING_REJECTED), dedupe on
 *     message_id/reading keys, OBSERVED evidence with provenance, heartbeat,
 *     realtime event and world-model refresh. Nothing is fabricated.
 *
 * GET /api/hardware/health — public probe (no secrets; only whether the key
 * is configured, never the key itself).
 */
import { Router } from "express";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { HttpError, rateLimit } from "../http";
import { newId } from "../util";
import {
  ingestValidatedReadings,
  maybeRefreshWorldModel,
  normalizeReadings,
  parseTimestamp,
  resolveDeviceByExternalId,
  validateReading,
  type MqttTelemetryPayload,
} from "../services/telemetry";

function gatewayToken(): string {
  return (process.env.HARDWARE_GATEWAY_TOKEN ?? "").trim();
}

export function hardwareGatewayRoutes(db: AppDb): Router {
  const r = Router();

  r.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "agrifur-hardware-gateway",
      gateway_configured: gatewayToken() !== "",
      time: new Date().toISOString(),
    });
  });

  r.post("/telemetry", rateLimit(120, 60_000), (req, res, next) => {
    try {
      const token = gatewayToken();
      if (token === "") {
        throw new HttpError(
          503,
          "GATEWAY_NOT_CONFIGURED",
          "Hardware gateway is not configured (set HARDWARE_GATEWAY_TOKEN on the server)",
        );
      }
      const provided = typeof req.headers["x-device-key"] === "string" ? req.headers["x-device-key"] : "";
      if (provided !== token) {
        throw new HttpError(401, "INVALID_DEVICE_KEY", "Missing or invalid x-device-key header");
      }

      // ---- parse the canonical firmware payload ---------------------------
      let payload: MqttTelemetryPayload;
      try {
        payload = req.body as MqttTelemetryPayload;
      } catch {
        throw new HttpError(400, "BAD_JSON", "Request body is not valid JSON");
      }
      if (typeof payload.device_id !== "string" || payload.device_id === "") {
        throw new HttpError(400, "MISSING_DEVICE_ID", "payload device_id is required");
      }

      // ---- device authority: registration decides the field ----------------
      const device = resolveDeviceByExternalId(db, payload.device_id);
      if (!device) {
        throw new HttpError(
          403,
          "DEVICE_NOT_REGISTERED",
          `Device "${payload.device_id}" is not registered — register it on its field first (Sensors workspace / POST /api/fields/{fieldId}/devices)`,
        );
      }
      if (payload.field_id !== undefined && payload.field_id !== null && String(payload.field_id) !== device.field_id) {
        throw new HttpError(409, "DEVICE_FIELD_MISMATCH", `payload field_id disagrees with the device's registered field — device registration is authoritative`);
      }

      const ts = parseTimestamp(payload.timestamp);
      if (!ts.ok) throw new HttpError(400, "BAD_TIMESTAMP", ts.reason);

      const norm = normalizeReadings(payload.readings);
      if (!norm.ok) throw new HttpError(400, "INVALID_READINGS", norm.reason);

      // per-reading hard-bound validation → reject the whole message
      let worst: "VALIDATED" | "SUSPECT" = "VALIDATED";
      const reasons: string[] = [];
      for (const rd of norm.list) {
        const v = validateReading(rd.sensor_type, rd.value);
        if (v.verdict === "REJECTED") throw new HttpError(400, "READING_REJECTED", v.reason);
        if (v.verdict === "SUSPECT") worst = "SUSPECT";
        reasons.push(`${rd.sensor_type}: ${v.reason}`);
      }

      const messageId = typeof payload.message_id === "string" && payload.message_id ? payload.message_id : `${Date.now()}-${newId("m").slice(-8)}`;
      const received = nowIso();
      const observedAt = ts.iso;
      const readings = norm.list.map((rd) => ({
        ...rd,
        observed_at: observedAt,
      }));

      const res2 = ingestValidatedReadings(db, {
        userId: device.user_id,
        farmId: device.farm_id,
        fieldId: device.field_id,
        device: { id: device.device_id, name: device.name, external_id: device.device_external_id },
        readings,
        transport: "https",
        messageId,
        receivedAt: received,
        firmwareVersion: typeof payload.firmware_version === "string" ? payload.firmware_version : null,
      });

      const firstForSensor = norm.list.some((rd) => {
        const n = db.conn.query("SELECT COUNT(*) AS n FROM observations WHERE field_id = ? AND sensor_type = ?").get(device.field_id, rd.sensor_type) as { n: number };
        return n.n <= 1;
      });
      maybeRefreshWorldModel(db, device.field_id, firstForSensor);

      const verdict =
        res2.inserted === 0 && res2.skippedDuplicates > 0
          ? "DUPLICATE"
          : worst === "SUSPECT"
            ? "SUSPECT"
            : res2.inserted > 0
              ? "VALIDATED"
              : "EMPTY";

      console.log(
        `[hardware-gateway] REAL HARDWARE OBSERVATION RECEIVED ${JSON.stringify({
          device_id: payload.device_id,
          device_db_id: device.device_id,
          field_id: device.field_id,
          sensor_types: norm.list.map((x) => x.sensor_type),
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
        device_id: device.device_external_id ?? device.device_id,
        field_id: device.field_id,
        note: "Readings stored as OBSERVED physical-sensor evidence (HTTPS hardware gateway).",
      });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
