import { Router } from "express";
import type { Request } from "express";
import type { AppDb } from "../db";
import { getOwnedField, requireAuth } from "../http";
import { evidenceGraph, listEvidence } from "../services/evidence";
import { latestWorldModel, worldModelHistory, worldModelDiff } from "../services/worldModel";
import { runFullFieldRefresh } from "../services/pipeline";
import { listMemory } from "../services/memory";

export function worldRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));

  const fieldOf = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  // Evidence for a field (domain/sub_type filters)
  // Run the full scheduled pipeline for this field now (same backend path the
  // worker uses: weather → satellite → soil → terrain → world model → intelligence).
  r.post("/fields/:id/refresh", async (req, res, next) => {
    try {
      const f = fieldOf(req);
      await runFullFieldRefresh(db, f.id);
      res.json({ ok: true, field_id: f.id, note: "Scheduled pipeline ran: weather, satellite discovery, soil, terrain, water (OSM), world model, intelligence." });
    } catch (e) {
      next(e);
    }
  });

  r.get("/fields/:id/evidence", (req, res, next) => {
    try {
      const f = fieldOf(req);
      const q = req.query as { domain?: string; sub_type?: string; limit?: string; states?: string };
      const states = q.states ? q.states.split(",") : undefined;
      const evidence = listEvidence(db, f.id, {
        domain: q.domain,
        subType: q.sub_type,
        limit: q.limit ? Math.min(parseInt(q.limit, 10) || 100, 500) : 100,
        states,
      });
      res.json({ evidence });
    } catch (e) {
      next(e);
    }
  });

  // Evidence graph: real cross-record relationships (contradictions,
  // investigation links, anomaly/risk citations). Field-scoped.
  r.get("/fields/:id/evidence/graph", (req, res, next) => {
    try {
      const f = fieldOf(req);
      res.json({ graph: evidenceGraph(db, f.id) });
    } catch (e) {
      next(e);
    }
  });

  // World model: latest snapshot
  r.get("/fields/:id/world-model", (req, res, next) => {
    try {
      const f = fieldOf(req);
      const latest = latestWorldModel(db, f.id);
      if (!latest) {
        res.json({ world_model: null });
        return;
      }
      res.json({ world_model: latest });
    } catch (e) {
      next(e);
    }
  });

  // World model history
  r.get("/fields/:id/world-model/history", (req, res, next) => {
    try {
      const f = fieldOf(req);
      res.json({ history: worldModelHistory(db, f.id) });
    } catch (e) {
      next(e);
    }
  });

  // Diff between two snapshots
  r.get("/fields/:id/world-model/diff", (req, res, next) => {
    try {
      const f = fieldOf(req);
      const before = String(req.query.before ?? "");
      const after = String(req.query.after ?? "");
      if (!before || !after) throw new Error("before and after query params are required");
      res.json({ diff: worldModelDiff(db, f.id, before, after) });
    } catch (e) {
      next(e);
    }
  });

  // Farm memory for a field
  r.get("/fields/:id/memory", (req, res, next) => {
    try {
      const f = fieldOf(req);
      res.json({ memory: listMemory(db, f.id) });
    } catch (e) {
      next(e);
    }
  });

  return r;
}