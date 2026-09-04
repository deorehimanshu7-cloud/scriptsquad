import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { getOwnedField, requireAuth, audit } from "../http";
import { newId } from "../util";
import { publishEvent } from "../services/events";
import { addMemory } from "../services/memory";
import { addEvidence } from "../services/evidence";

const obsSchema = z.object({
  text: z.string().min(2).max(2000),
  tags: z.array(z.string().max(60)).max(12).optional(),
});

export function farmerRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  r.get("/fields/:id/farmer-observations", (req, res) => {
    const f = fld(req);
    const rows = db.conn
      .query(
        "SELECT id, text, tags, state, verified, verified_by, verified_at, created_at FROM farmer_observations WHERE field_id = ? ORDER BY created_at DESC LIMIT 200",
      )
      .all(f.id) as { tags: string | null }[];
    res.json({ observations: rows.map((x) => ({ ...x, tags: x.tags ? JSON.parse(x.tags) : [] })) });
  });

  r.post("/fields/:id/farmer-observations", (req, res, next) => {
    try {
      const f = fld(req);
      const body = obsSchema.parse(req.body);
      const id = newId("fobs");
      const tags = body.tags ?? [];
      db.conn
        .query(
          "INSERT INTO farmer_observations (id, user_id, farm_id, field_id, text, tags, state, verified, verified_by, verified_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(id, req.user!.id, f.farm_id, f.id, body.text, JSON.stringify(tags), "OBSERVED", 0, null, null, nowIso());
      // Farmer input also enters the evidence layer as OBSERVED (farmer-reported)
      addEvidence(db, {
        userId: req.user!.id,
        farmId: f.farm_id,
        fieldId: f.id,
        domain: "farmer",
        source: "Farmer (web input)",
        source_type: "farmer",
        sub_type: tags.includes("reported_no_rain") ? "reported_no_rain" : "field_observation",
        measurement: null,
        value: null,
        unit: null,
        state: "OBSERVED",
        observed_at: nowIso(),
        description: body.text,
        provenance: { provider: "farmer", note: "Farmer-reported observation; not independently verified (verified=0)." },
      });
      audit(db, req.user!.id, "farmer.observation", `field:${f.id}`, { tags });
      addMemory(db, {
        userId: req.user!.id,
        farmId: f.farm_id,
        fieldId: f.id,
        kind: "observation",
        title: "Farmer observation",
        summary: body.text.slice(0, 180),
      });
      publishEvent(db, {
        type: "FARMER_OBSERVATION_ADDED",
        user_id: req.user!.id,
        farm_id: f.farm_id,
        field_id: f.id,
        payload: { observation_id: id, tags },
      });
      const row = db.conn.query("SELECT * FROM farmer_observations WHERE id = ?").get(id) as Record<string, unknown>;
      res.status(201).json({ observation: { ...row, tags: typeof row.tags === "string" ? JSON.parse(row.tags) : [] } });
    } catch (e) {
      next(e);
    }
  });

  r.patch("/fields/:id/farmer-observations/:obsId", (req, res, next) => {
    try {
      const f = fld(req);
      const row = db.conn
        .query("SELECT id FROM farmer_observations WHERE id = ? AND field_id = ?")
        .get(req.params.obsId, f.id) as { id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Observation not found" } });
        return;
      }
      const body = z.object({ verified: z.boolean() }).parse(req.body);
      db.conn
        .query("UPDATE farmer_observations SET verified = ?, verified_by = ?, verified_at = ? WHERE id = ?")
        .run(body.verified ? 1 : 0, body.verified ? req.user!.name : null, body.verified ? nowIso() : null, row.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}