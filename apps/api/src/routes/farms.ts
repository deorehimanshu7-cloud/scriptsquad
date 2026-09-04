import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { HttpError, getOwnedFarm, requireAuth, audit } from "../http";
import { newId, round } from "../util";
import { areaM2, bboxOf, centroidOf, validateGeometry, type BBox } from "../geo";
import { getFieldRow } from "../services/worldModel";
import type { FieldRecord, FieldGeometry } from "contracts";
import { publishEvent } from "../services/events";

const farmSchema = z.object({
  name: z.string().min(1).max(120),
  location_name: z.string().max(240).optional().nullable(),
});

const fieldSchema = z.object({
  farm_id: z.string().min(1),
  name: z.string().min(1).max(120),
  crop_name: z.string().max(120).optional().nullable(),
  geometry: z.object({
    type: z.enum(["Polygon", "MultiPolygon"]),
    coordinates: z.unknown(),
  }),
});

const fieldPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  crop_name: z.string().max(120).optional().nullable(),
});

export function farmRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));

  // ---- farms --------------------------------------------------------------
  r.get("/farms", (req, res) => {
    const rows = db.conn
      .query("SELECT id, user_id, name, location_name, created_at, updated_at FROM farms WHERE user_id = ? ORDER BY created_at ASC")
      .all(req.user!.id);
    res.json({ farms: rows });
  });

  r.post("/farms", (req, res, next) => {
    try {
      const body = farmSchema.parse(req.body);
      const id = newId("farm");
      const now = nowIso();
      db.conn
        .query("INSERT INTO farms (id, user_id, name, location_name, created_at, updated_at) VALUES (?,?,?,?,?,?)")
        .run(id, req.user!.id, body.name, body.location_name ?? null, now, now);
      audit(db, req.user!.id, "farm.create", `farm:${id}`, { name: body.name });
      res.status(201).json({ farm: { id, user_id: req.user!.id, name: body.name, location_name: body.location_name ?? null, created_at: now, updated_at: now } });
    } catch (e) {
      next(e);
    }
  });

  // ---- fields -------------------------------------------------------------
  r.get("/fields", (_req, res) => {
    const rows = db.conn
      .query(
        `SELECT f.*, farm.name as farm_name FROM fields f LEFT JOIN farms farm ON farm.id = f.farm_id
         WHERE f.user_id = ? ORDER BY f.created_at ASC`,
      )
      .all(_req.user!.id) as unknown as (FieldRecord & { geometry: string; bbox: string; farm_name: string | null })[];
    const fields = rows.map(({ geometry, bbox, ...rest }) => ({
      ...rest,
      geometry: JSON.parse(geometry),
      bbox: JSON.parse(bbox),
    }));
    res.json({ fields });
  });

  r.post("/fields", (req, res, next) => {
    try {
      const body = fieldSchema.parse(req.body);
      getOwnedFarm(db, body.farm_id, req.user!);
      const geoValid = validateGeometry(body.geometry as FieldGeometry);
      if (!geoValid.ok) throw new HttpError(400, "INVALID_GEOMETRY", geoValid.error);
      const centroid = centroidOf(body.geometry as FieldGeometry);
      const bbox = bboxOf(body.geometry as FieldGeometry);
      const area = areaM2(body.geometry as FieldGeometry);
      const id = newId("fld");
      const now = nowIso();
      db.conn
        .query(
          `INSERT INTO fields (id, farm_id, user_id, name, crop_name, geometry, centroid_lat, centroid_lon, bbox, area_m2, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          body.farm_id,
          req.user!.id,
          body.name,
          body.crop_name ?? null,
          JSON.stringify(body.geometry),
          centroid.lat,
          centroid.lon,
          JSON.stringify(bbox satisfies BBox),
          area,
          now,
          now,
        );
      audit(db, req.user!.id, "field.create", `field:${id}`, { name: body.name, area_m2: area });
      const field = getFieldRow(db, id);
      res.status(201).json({ field });
    } catch (e) {
      next(e);
    }
  });

  r.get("/fields/:id", (req, res, next) => {
    try {
      const field = getFieldRow(db, req.params.id);
      if (!field || (field.user_id !== req.user!.id && req.user!.role !== "admin")) {
        throw new HttpError(404, "FIELD_NOT_FOUND", "Field not found");
      }
      res.json({ field });
    } catch (e) {
      next(e);
    }
  });

  r.patch("/fields/:id", (req, res, next) => {
    try {
      const field = getFieldRow(db, req.params.id);
      if (!field || (field.user_id !== req.user!.id && req.user!.role !== "admin")) {
        throw new HttpError(404, "FIELD_NOT_FOUND", "Field not found");
      }
      const body = fieldPatchSchema.parse(req.body);
      const name = body.name ?? field.name;
      const crop_name = body.crop_name !== undefined ? body.crop_name : field.crop_name;
      db.conn
        .query("UPDATE fields SET name = ?, crop_name = ?, updated_at = ? WHERE id = ?")
        .run(name, crop_name, nowIso(), field.id);
      audit(db, req.user!.id, "field.update", `field:${field.id}`, body);
      res.json({ field: getFieldRow(db, field.id) });
    } catch (e) {
      next(e);
    }
  });

  r.delete("/fields/:id", (req, res, next) => {
    try {
      const field = getFieldRow(db, req.params.id);
      if (!field || (field.user_id !== req.user!.id && req.user!.role !== "admin")) {
        throw new HttpError(404, "FIELD_NOT_FOUND", "Field not found");
      }
      // cascade: children of fields are removed by SQLite FK cascade where defined;
      // evidence/observations/etc carry field_id without FK so clean them explicitly
      for (const t of ["evidence", "observations", "satellite_products", "farmer_observations", "actions", "verifications", "anomalies", "risks", "uncertainties", "contradictions", "investigations", "world_model_states", "simulations", "farm_memory", "events", "jobs"]) {
        db.conn.query(`DELETE FROM ${t} WHERE field_id = ?`).run(field.id);
      }
      db.conn.query("DELETE FROM fields WHERE id = ?").run(field.id);
      audit(db, req.user!.id, "field.delete", `field:${field.id}`);
      publishEvent(db, { type: "FIELD_UPDATED", user_id: req.user!.id, payload: { deleted: field.id } });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

export function fmtArea(area: number | null): string | null {
  if (!area) return null;
  return `${round(area / 10_000, 2)} ha`;
}