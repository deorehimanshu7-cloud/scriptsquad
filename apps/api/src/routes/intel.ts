import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import type { AppDb } from "../db";
import { getOwnedField, requireAuth } from "../http";
import { runIntelligence } from "../services/engines";
import { composeWorldModel, saveWorldModelSnapshot } from "../services/worldModel";
import {
  autoInvestigate,
  createHypothesis,
  createInvestigation,
  enrichInvestigation,
  getInvestigation,
  listInvestigations,
  setHypothesisStatus,
  updateInvestigation,
} from "../services/investigations";
import { publishEvent } from "../services/events";
import { addMemory } from "../services/memory";
import { nowIso } from "../db";
import { newId } from "../util";

export function intelRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  const readAll = (req: Request) => {
    const f = fld(req);
    const anomalies = db.conn
      .query("SELECT * FROM anomalies WHERE field_id = ? ORDER BY detected_at DESC LIMIT 100")
      .all(f.id) as never[];
    const risks = db.conn
      .query("SELECT * FROM risks WHERE field_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(f.id) as never[];
    const uncertainties = db.conn
      .query("SELECT * FROM uncertainties WHERE field_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(f.id) as never[];
    const contradictions = db.conn
      .query("SELECT * FROM contradictions WHERE field_id = ? ORDER BY created_at DESC LIMIT 100")
      .all(f.id) as never[];
    return { anomalies, risks, uncertainties, contradictions };
  };

  r.get("/fields/:id/anomalies", (req, res) => {
    res.json({ anomalies: readAll(req).anomalies });
  });

  r.get("/fields/:id/risks", (req, res) => {
    res.json({ risks: readAll(req).risks });
  });

  r.get("/fields/:id/uncertainties", (req, res) => {
    res.json({ uncertainties: readAll(req).uncertainties });
  });

  r.get("/fields/:id/contradictions", (req, res) => {
    res.json({ contradictions: readAll(req).contradictions });
  });

  r.get("/fields/:id/intelligence", (req, res) => {
    res.json(readAll(req));
  });

  // Run the intelligence engines now (also re-composes the world model first)
  r.post("/fields/:id/analyze", (req, res, next) => {
    try {
      const f = fld(req);
      const composed = composeWorldModel(db, f.id);
      saveWorldModelSnapshot(db, f.id, "MANUAL_ANALYZE", composed.snapshot);
      const report = runIntelligence(db, f.id);
      publishEvent(db, {
        type: "RISK_UPDATED",
        user_id: req.user!.id,
        farm_id: f.farm_id,
        field_id: f.id,
        payload: report,
      });
      res.json({ report, ...readAll(req) });
    } catch (e) {
      next(e);
    }
  });

  // ---- actions & verification (DECISION → ACTION → VERIFICATION → memory) ----
  r.get("/fields/:id/actions", (req, res) => {
    const f = fld(req);
    const actions = db.conn
      .query(
        `SELECT a.*, r.risk_type, r.level as risk_level, r.evidence_ids
         FROM actions a LEFT JOIN risks r ON r.id = a.recommendation_from
         WHERE a.field_id=? ORDER BY a.created_at DESC LIMIT 100`,
      )
      .all(f.id);
    res.json({ actions });
  });

  r.get("/fields/:id/verifications", (req, res) => {
    const f = fld(req);
    const verifications = db.conn
      .query(
        `SELECT v.*, a.title as action_title
         FROM verifications v LEFT JOIN actions a ON a.id = v.action_id
         WHERE v.field_id=? ORDER BY v.verified_at DESC LIMIT 100`,
      )
      .all(f.id);
    res.json({ verifications });
  });

  r.get("/fields/:id/evidence/relationships", (req, res) => {
    const f = fld(req);
    const relationships = db.conn
      .query(
        `SELECT rel.id, rel.evidence_a, rel.evidence_b, rel.relationship, rel.reason, rel.created_at,
                ea.sub_type as a_sub, ea.domain as a_domain, ea.description as a_desc,
                eb.sub_type as b_sub, eb.domain as b_domain, eb.description as b_desc
         FROM evidence_relationships rel
         LEFT JOIN evidence ea ON ea.id = rel.evidence_a
         LEFT JOIN evidence eb ON eb.id = rel.evidence_b
         WHERE rel.field_id=? ORDER BY rel.created_at DESC LIMIT 100`,
      )
      .all(f.id);
    res.json({ relationships });
  });

  const actionStatusSchema = z.object({
    status: z.enum(["taken", "verified", "dismissed"]),
    outcome: z.string().max(1000).optional().nullable(),
  });
  r.post("/fields/:id/actions/:actionId/status", (req, res, next) => {
    try {
      const f = fld(req);
      const parsed = actionStatusSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: { code: "BAD_REQUEST", message: parsed.error.message } });
        return;
      }
      const { status, outcome } = parsed.data;
      const act = db.conn
        .query("SELECT * FROM actions WHERE id=? AND field_id=?")
        .get(req.params.actionId, f.id) as { id: string; title: string; user_id: string; farm_id: string; field_id: string } | undefined;
      if (!act) {
        res.status(404).json({ error: { code: "ACTION_NOT_FOUND", message: "Action not found on this field" } });
        return;
      }
      db.conn.query("UPDATE actions SET status=?, updated_at=? WHERE id=?").run(status, nowIso(), act.id);
      let verificationId: string | null = null;
      if (status === "verified") {
        verificationId = newId("ver");
        db.conn
          .query(
            `INSERT INTO verifications (id, user_id, farm_id, field_id, action_id, outcome, state, verified_at, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(verificationId, f.user_id, f.farm_id, f.id, act.id, outcome ?? null, "OBSERVED", nowIso(), nowIso());
        addMemory(db, {
          userId: f.user_id,
          farmId: f.farm_id,
          fieldId: f.id,
          kind: "verification",
          title: `Action verified: ${act.title}`,
          summary: outcome ? `Outcome recorded: ${outcome}` : "Farmer marked the recommended action as verified (no outcome text).",
          refId: act.id,
        });
      } else if (status === "taken") {
        addMemory(db, {
          userId: f.user_id,
          farmId: f.farm_id,
          fieldId: f.id,
          kind: "action_taken",
          title: `Action taken: ${act.title}`,
          summary: "Farmer marked the recommended action as taken.",
          refId: act.id,
        });
      }
      publishEvent(db, {
        type: "ACTION_CREATED",
        user_id: f.user_id,
        farm_id: f.farm_id,
        field_id: f.id,
        payload: { action_id: act.id, status, verification_id: verificationId },
      });
      res.json({ ok: true, action: { id: act.id, status }, verification_id: verificationId });
    } catch (e) {
      next(e);
    }
  });

  // ---- investigations ------------------------------------------------------
  const invSchema = z.object({
    title: z.string().min(2).max(200),
    problem: z.string().min(5).max(2000),
    trigger: z.string().optional().nullable(),
    evidence_ids: z.array(z.string()).optional(),
    auto: z.boolean().optional(),
  });

  r.get("/fields/:id/investigations", (req, res) => {
    res.json({ investigations: listInvestigations(db, fld(req).id) });
  });

  r.post("/fields/:id/investigations", (req, res, next) => {
    try {
      const f = fld(req);
      const body = invSchema.parse(req.body);
      const detail = createInvestigation(db, {
        userId: req.user!.id,
        farmId: f.farm_id,
        fieldId: f.id,
        title: body.title,
        problem: body.problem,
        trigger: body.trigger ?? "manual",
        evidenceIds: body.evidence_ids ?? [],
      });
      if (body.auto !== false) enrichInvestigation(db, f.id, detail.id);
      res.status(201).json({ investigation: detail });
    } catch (e) {
      next(e);
    }
  });

  r.get("/investigations/:id", (req, res, next) => {
    try {
      const row = db.conn
        .query("SELECT field_id FROM investigations WHERE id = ?")
        .get(req.params.id) as { field_id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Investigation not found" } });
        return;
      }
      getOwnedField(db, row.field_id, req.user!);
      const detail = getInvestigation(db, row.field_id, req.params.id);
      res.json({ investigation: detail });
    } catch (e) {
      next(e);
    }
  });

  r.patch("/investigations/:id", (req, res, next) => {
    try {
      const row = db.conn
        .query("SELECT field_id FROM investigations WHERE id = ?")
        .get(req.params.id) as { field_id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Investigation not found" } });
        return;
      }
      getOwnedField(db, row.field_id, req.user!);
      const body = z.object({ status: z.string().optional(), conclusion: z.string().nullable().optional() }).parse(req.body);
      const detail = updateInvestigation(db, row.field_id, req.params.id, body);
      res.json({ investigation: detail });
    } catch (e) {
      next(e);
    }
  });

  r.post("/investigations/:id/hypotheses", (req, res, next) => {
    try {
      const row = db.conn
        .query("SELECT field_id FROM investigations WHERE id = ?")
        .get(req.params.id) as { field_id: string } | undefined;
      if (!row) throw new Error("investigation not found");
      getOwnedField(db, row.field_id, req.user!);
      const body = z.object({ statement: z.string().min(3).max(500) }).parse(req.body);
      createHypothesis(db, row.field_id, req.params.id, body.statement);
      res.json({ investigation: getInvestigation(db, row.field_id, req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  r.patch("/investigations/:id/hypotheses/:hypId", (req, res, next) => {
    try {
      const row = db.conn
        .query("SELECT field_id FROM investigations WHERE id = ?")
        .get(req.params.id) as { field_id: string } | undefined;
      if (!row) throw new Error("investigation not found");
      getOwnedField(db, row.field_id, req.user!);
      const body = z.object({ status: z.enum(["proposed", "testing", "supported", "rejected", "inconclusive"]) }).parse(req.body);
      setHypothesisStatus(db, req.params.id, req.params.hypId, body.status);
      res.json({ investigation: getInvestigation(db, row.field_id, req.params.id) });
    } catch (e) {
      next(e);
    }
  });

  // Auto-investigate from the most severe open anomaly/contradiction
  r.post("/fields/:id/investigations/auto", (req, res, next) => {
    try {
      const f = fld(req);
      const anom = db.conn
        .query("SELECT id, kind, description, evidence_ids FROM anomalies WHERE field_id = ? AND status = 'open' ORDER BY detected_at DESC LIMIT 1")
        .get(f.id) as { id: string; kind: string; description: string; evidence_ids: string } | undefined;
      const detail = autoInvestigate(db, f.id, {
        kind: anom?.kind ?? "manual_review",
        description: anom?.description ?? "General field review requested.",
        evidenceIds: anom ? JSON.parse(anom.evidence_ids) : [],
      });
      res.status(201).json({ investigation: detail });
    } catch (e) {
      next(e);
    }
  });

  return r;
}