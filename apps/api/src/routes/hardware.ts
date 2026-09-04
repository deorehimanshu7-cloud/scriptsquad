import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { HttpError, getOwnedField, requireAuth, rateLimit, audit, validate } from "../http";
import { newId } from "../util";
import { addMemory } from "../services/memory";
import { deviceHealth, ingestValidatedReadings, type ReadingsIn } from "../services/telemetry";

const deviceSchema = z.object({
  name: z.string().min(1).max(120),
  /** stable firmware/MQTT identity, e.g. AGRIFUR-ESP32-001 — what the device publishes */
  device_id: z.string().min(1).max(120).optional().nullable(),
  kind: z.enum(["sensor_node", "voice_device", "gateway"]).optional(),
  firmware_version: z.string().max(60).optional().nullable(),
  metadata: z.record(z.unknown()).optional(),
});

const ingestSchema = z.object({
  device_id: z.string().min(1),
  readings: z
    .array(
      z.object({
        sensor_type: z.string().min(1).max(80),
        value: z.number(),
        unit: z.string().max(20).optional().nullable(),
        observed_at: z.string().optional(),
        ingestion_id: z.string().max(120).optional(),
        quality: z.enum(["high", "medium", "low"]).optional().nullable(),
      }),
    )
    .min(1)
    .max(50),
});

export function hardwareRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  r.get("/fields/:id/devices", (req, res) => {
    const f = fld(req);
    const devices = db.conn
      .query(
        `SELECT d.*,
                (SELECT COUNT(*) FROM observations o WHERE o.device_id = d.id) AS telemetry_count,
                (SELECT MAX(o.observed_at) FROM observations o WHERE o.device_id = d.id) AS last_telemetry_at
         FROM devices d WHERE d.field_id = ? ORDER BY d.created_at ASC`,
      )
      .all(f.id) as Record<string, unknown>[];
    const out = devices.map((d) => {
      const meta = typeof d.metadata === "string" ? (JSON.parse(d.metadata) as Record<string, unknown>) : (d.metadata as Record<string, unknown> | null) ?? null;
      const health = deviceHealth(db, { status: String(d.status ?? "registered"), last_seen_at: (d.last_seen_at as string | null) ?? null });
      return {
        id: d.id,
        user_id: d.user_id,
        farm_id: d.farm_id,
        field_id: d.field_id,
        external_id: d.external_id ?? null,
        name: d.name,
        kind: d.kind,
        firmware_version: d.firmware_version ?? null,
        status: health.status,
        effective_status: health.effective_status,
        seconds_since_seen: health.seconds_since_seen,
        last_seen_at: d.last_seen_at ?? null,
        telemetry_count: Number(d.telemetry_count ?? 0),
        last_telemetry_at: d.last_telemetry_at ?? null,
        metadata: meta,
        created_at: d.created_at,
      };
    });
    res.json({ devices: out });
  });

  r.post("/fields/:id/devices", (req, res, next) => {
    try {
      const f = fld(req);
      const body = validate(deviceSchema, req.body);
      const externalId = body.device_id ? body.device_id.trim() : null;
      if (externalId) {
        const existing = db.conn.query("SELECT id, field_id, name FROM devices WHERE external_id = ?").get(externalId) as { id: string; field_id: string | null; name: string } | undefined;
        if (existing) {
          throw new HttpError(409, "DEVICE_ID_TAKEN", `Device id "${externalId}" is already registered (${existing.name}) — reuse it or pick another`);
        }
      }
      const id = newId("dev");
      db.conn
        .query(
          "INSERT INTO devices (id, user_id, farm_id, field_id, external_id, name, kind, firmware_version, status, last_seen_at, metadata, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          req.user!.id,
          f.farm_id,
          f.id,
          externalId,
          body.name,
          body.kind ?? "sensor_node",
          body.firmware_version ?? null,
          "registered",
          null,
          body.metadata ? JSON.stringify(body.metadata) : null,
          nowIso(),
        );
      audit(db, req.user!.id, "device.register", `device:${id}`, { field_id: f.id, external_id: externalId });
      addMemory(db, {
        userId: req.user!.id,
        farmId: f.farm_id,
        fieldId: f.id,
        kind: "observation",
        title: `Device registered: ${body.name}`,
        summary: `${body.kind ?? "sensor_node"} registered on field ${f.name}${externalId ? ` (id ${externalId})` : ""}. Status: registered (no telemetry yet).`,
      });
      const device = db.conn.query("SELECT * FROM devices WHERE id = ?").get(id);
      res.status(201).json({ device });
    } catch (e) {
      next(e);
    }
  });

  // Telemetry ingestion — the hardware gateway endpoint (HTTPS). Shares the
  // exact same pipeline as the MQTT subscriber (dedupe, range validation,
  // OBSERVED evidence, heartbeat, realtime event) — no duplicate logic.
  r.post(
    "/fields/:id/observations",
    rateLimit(120, 60_000),
    (req, res, next) => {
      try {
        const f = fld(req);
        const body = validate(ingestSchema, req.body);
        const device = db.conn
          .query("SELECT id, name, external_id FROM devices WHERE id = ? AND field_id = ?")
          .get(body.device_id, f.id) as { id: string; name: string; external_id: string | null } | undefined;
        if (!device) throw new HttpError(404, "DEVICE_NOT_FOUND", "Device not found on this field");
        const received = nowIso();
        const readings: ReadingsIn = body.readings.map((rd) => ({
          sensor_type: rd.sensor_type,
          value: rd.value,
          unit: rd.unit ?? null,
          ingestion_id: rd.ingestion_id ?? undefined,
          quality: rd.quality ?? undefined,
          observed_at: rd.observed_at ?? undefined,
        }));
        const res2 = ingestValidatedReadings(db, {
          userId: req.user!.id,
          farmId: f.farm_id,
          fieldId: f.id,
          device: { id: device.id, name: device.name, external_id: device.external_id },
          readings,
          transport: "https",
          messageId: newId("m"),
          receivedAt: received,
          ingestionKey: (rd) => rd.ingestion_id ?? `${device.id}:${rd.sensor_type}:${rd.observed_at ?? received}`,
        });
        res.json({ ok: true, inserted: res2.inserted, skipped_duplicates: res2.skippedDuplicates, rejected: res2.rejected });
      } catch (e) {
        next(e);
      }
    },
  );

  // Observation time series for a field/sensor type
  r.get("/fields/:id/observations", (req, res) => {
    const f = fld(req);
    const sensorType = String(req.query.type ?? "");
    const limit = Math.min(parseInt(String(req.query.limit ?? "200"), 10) || 200, 2000);
    const rows = sensorType
      ? db.conn
          .query(
            "SELECT id, device_id, sensor_type, value, unit, observed_at, received_at, quality, ingestion_id FROM observations WHERE field_id = ? AND sensor_type = ? ORDER BY observed_at DESC LIMIT ?",
          )
          .all(f.id, sensorType, String(limit))
      : db.conn
          .query(
            "SELECT id, device_id, sensor_type, value, unit, observed_at, received_at, quality, ingestion_id FROM observations WHERE field_id = ? ORDER BY observed_at DESC LIMIT ?",
          )
          .all(f.id, String(limit));
    res.json({ observations: rows });
  });

  return r;
}