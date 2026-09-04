import { Router } from "express";
import type { Request, Response } from "express";
import type { AppDb } from "../db";
import { getOwnedField, requireAuth } from "../http";
import { recentJobs } from "../services/jobs";
import { recentEvents, onEvent } from "../services/events";
import { providerHealthSnapshot, recordHealth } from "../providers/orchestrator";
import { PROVIDER_METAS } from "../providers/types";
import { config } from "../config";
import type { ProviderId } from "contracts";

export function systemRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));

  r.get("/health", (_req, res) => {
    res.json({ ok: true, service: "agrifur-api", time: new Date().toISOString() });
  });

  r.get("/system/status", (_req, res) => {
    const dbOk = (() => {
      try {
        db.conn.query("SELECT 1 as one").get();
        return true;
      } catch {
        return false;
      }
    })();
    const counts = {
      users: (db.conn.query("SELECT COUNT(*) as n FROM users").get() as { n: number }).n,
      fields: (db.conn.query("SELECT COUNT(*) as n FROM fields").get() as { n: number }).n,
      evidence: (db.conn.query("SELECT COUNT(*) as n FROM evidence").get() as { n: number }).n,
      jobs: (db.conn.query("SELECT COUNT(*) as n FROM jobs").get() as { n: number }).n,
    };
    res.json({
      ok: dbOk,
      service: "agrifur-api",
      version: "0.1.0",
      uptime_seconds: Math.round(process.uptime()),
      database: { ok: dbOk, location: db.location },
      counts,
      workers: {
        weather_interval_seconds: config.jobWeatherSeconds,
        satellite_interval_seconds: config.jobSatelliteSeconds,
        soil_interval_seconds: config.jobSoilSeconds,
        world_model_interval_seconds: config.jobWorldModelSeconds,
        intelligence_interval_seconds: config.jobIntelligenceSeconds,
        provider_health_interval_seconds: config.jobProviderHealthSeconds,
        worker_tick_ms: config.workerTickMs,
      },
      truthfulness: "Every evidence value carries a truth state; unavailable providers are reported with explicit states, never filled with fake data.",
    });
  });

  r.get("/jobs", (req, res) => {
    const fieldId = typeof req.query.field_id === "string" ? req.query.field_id : undefined;
    if (fieldId) getOwnedField(db, fieldId, req.user!);
    res.json({ jobs: recentJobs(db, { fieldId, limit: 100 }) });
  });

  r.get("/events", (req, res) => {
    const fieldId = typeof req.query.field_id === "string" ? req.query.field_id : undefined;
    if (fieldId) getOwnedField(db, fieldId, req.user!);
    const events = recentEvents(db, {
      fieldId,
      userId: req.user!.id,
      type: typeof req.query.type === "string" ? req.query.type : undefined,
      limit: 100,
    });
    res.json({ events });
  });

  // Server-Sent Events stream for live updates. Events are filtered to the
  // authenticated user's own records (field-scoped when a field_id is given):
  // a farmer must never receive another user's telemetry/world-model events.
  r.get("/events/stream", (req, res, next) => {
    const fieldFilter = typeof req.query.field_id === "string" ? req.query.field_id : null;
    if (fieldFilter) {
      try {
        getOwnedField(db, fieldFilter, req.user!); // 404/403 unless owned
      } catch (e) {
        next(e);
        return;
      }
    }
    const viewerId = req.user!.id;
    const isAdmin = req.user!.role === "admin";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const send = (e: unknown) => {
      const ev = e as { user_id?: string | null; field_id?: string | null };
      // hard ownership boundary: only the user's own records (admins see all)
      if (!isAdmin && ev.user_id && ev.user_id !== viewerId) return;
      if (fieldFilter && ev.field_id && ev.field_id !== fieldFilter) return;
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    const off = onEvent(send);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      off();
    });
  });

  // Provider health (persisted states + current pings)
  r.get("/providers", async (_req, res, next) => {
    try {
      const metas = Object.values(PROVIDER_METAS);
      const healthRows = db.conn.query("SELECT * FROM provider_health").all() as Record<string, unknown>[];
      const health = new Map(healthRows.map((h) => [String(h.provider), h]));
      const providers = metas.map((m) => ({
        ...m,
        health: health.get(m.id) ?? {
          provider: m.id,
          status: m.auth_state === "required" ? "NOT_CONFIGURED" : m.auth_state === "configured" ? "AVAILABLE" : "NOT_CONFIGURED",
          last_check_at: null,
          last_success_at: null,
          last_error_at: null,
          last_error: null,
          latency_ms: null,
          auth_state: m.auth_state,
          note: null,
        },
      }));
      res.json({ providers });
    } catch (e) {
      next(e);
    }
  });

  // Run provider health checks now
  r.post("/providers/check", async (_req, res, next) => {
    try {
      await providerHealthSnapshot(db);
      const healthRows = db.conn.query("SELECT * FROM provider_health").all() as Record<string, unknown>[];
      res.json({ providers: healthRows });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

/** Public unauthenticated health probe used by previews/load balancers. */
export function publicHealthRoute(db: AppDb) {
  return (_req: Request, res: Response) => {
    let ok = true;
    try {
      db.conn.query("SELECT 1 as one").get();
    } catch {
      ok = false;
    }
    res.status(ok ? 200 : 503).json({ ok, service: "agrifur-api", time: new Date().toISOString() });
  };
}

export function seedProviderStates(db: AppDb): void {
  for (const p of Object.keys(PROVIDER_METAS) as ProviderId[]) {
    const meta = PROVIDER_METAS[p];
    const configured = meta.auth_state === "configured";
    recordHealth(db, p, configured ? "AVAILABLE" : "NOT_CONFIGURED", null, null);
    // initial state lives in the note column (cleared on the next probe) — never
    // in last_error, so a later AVAILABLE result can't sit next to a stale
    // "not configured" error message.
    db.conn.query("UPDATE provider_health SET note = ? WHERE provider = ?").run(
      configured ? null : "Initial state — will be probed by the worker.",
      p,
    );
  }
}