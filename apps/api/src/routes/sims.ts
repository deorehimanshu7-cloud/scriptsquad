import { Router } from "express";
import { z } from "zod";
import type { Request } from "express";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { getOwnedField, requireAuth, audit } from "../http";
import { jsonParse, newId, round } from "../util";
import { publishEvent } from "../services/events";
import { addMemory } from "../services/memory";
import { addEvidence } from "../services/evidence";

const simSchema = z.object({
  name: z.string().min(2).max(120),
  scenario: z.string().min(2).max(400),
  inputs: z
    .object({
      rainfall_mm: z.number().min(0).max(1000).optional(),
      irrigation_mm: z.number().min(0).max(2000).optional(),
      crop_factor_kc: z.number().min(0.1).max(1.5).optional(),
      days: z.number().int().min(1).max(180).optional(),
      /**
       * uniform       — every day uses the user-entered mm/day values (default)
       * field_climate — daily baseline taken from this field's REAL recorded
       *                 ET0/precipitation weather evidence; the user inputs act
       *                 as fallback for days the evidence does not cover.
       * Either way the output is SIMULATED — never an observation.
       */
      et0_source: z.enum(["uniform", "field_climate"]).optional(),
    })
    .optional(),
});

interface SimRow {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  name: string;
  scenario: string;
  model: string;
  model_version: string;
  inputs: string;
  assumptions?: string | null;
  limitations?: string | null;
  status: string;
  created_at: string;
}

export interface SimOutput {
  state: "SIMULATED";
  model: string;
  inputs: Record<string, unknown>;
  daily: { day: number; rain_mm: number; et_mm: number; balance_mm: number; cumulative_mm: number }[];
  cumulative_end_mm: number;
  source: "uniform" | "field_climate";
  climate?: { days_used: number; horizon_days: number; note: string };
  assumptions?: string | null;
  limitations?: string | null;
  disclaimer: string;
}

/**
 * Recent real climate for a field: the last `days` calendar dates that have an
 * ET0 evidence row (first value per day), with that day's recorded precipitation
 * (missing = 0, noted in limitations). Returns [] when the field has no usable
 * ET0 history.
 */
function recentClimateDays(db: AppDb, fieldId: string, days: number): { date: string; rain_mm: number; et0_mm: number }[] {
  const etRows = db.conn
    .query(
      "SELECT observed_at, value FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='et0_fao_evapotranspiration' AND value IS NOT NULL ORDER BY observed_at ASC",
    )
    .all(fieldId) as { observed_at: string; value: number }[];
  const prRows = db.conn
    .query(
      "SELECT observed_at, value FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='precipitation_sum' AND value IS NOT NULL ORDER BY observed_at ASC",
    )
    .all(fieldId) as { observed_at: string; value: number }[];
  const et0ByDay = new Map<string, number>();
  for (const r of etRows) {
    const d = r.observed_at.slice(0, 10);
    if (!et0ByDay.has(d)) et0ByDay.set(d, r.value);
  }
  const rainByDay = new Map<string, number>();
  for (const r of prRows) {
    const d = r.observed_at.slice(0, 10);
    if (!rainByDay.has(d)) rainByDay.set(d, r.value);
  }
  return [...et0ByDay.keys()]
    .sort()
    .slice(-days)
    .map((date) => ({ date, rain_mm: rainByDay.get(date) ?? 0, et0_mm: et0ByDay.get(date) ?? 0 }));
}

/** Deterministic daily water balance. Persists the run + SIMULATED evidence. */
function executeSimulation(db: AppDb, userId: string, row: SimRow): { runId: string; output: SimOutput } {
  const inputs = jsonParse(row.inputs ?? "{}", {
    rainfall_mm: 0,
    irrigation_mm: 0,
    crop_factor_kc: 1,
    days: 30,
    et0_mm: 5,
    et0_source: "uniform",
  });
  const days = Math.max(1, Math.min(180, Number(inputs.days ?? 30)));
  const rainUniform = Number(inputs.rainfall_mm ?? 0);
  const irrigationUniform = Number(inputs.irrigation_mm ?? 0);
  const kc = Number(inputs.crop_factor_kc ?? 1);
  const source: "uniform" | "field_climate" = inputs.et0_source === "field_climate" ? "field_climate" : "uniform";

  const realDays = source === "field_climate" ? recentClimateDays(db, String(row.field_id), days) : [];
  const nReal = realDays.length;
  const meanEt0 = nReal > 0 ? realDays.reduce((a, d) => a + d.et0_mm, 0) / nReal : Number(inputs.et0_mm ?? 5);
  const fallbackEt0 = Number.isFinite(meanEt0) && meanEt0 > 0 ? meanEt0 : Number(inputs.et0_mm ?? 5);

  const daily: SimOutput["daily"] = [];
  let cumulative = 0;
  for (let d = 1; d <= days; d++) {
    // Real evidence is aligned to the END of the horizon (the most recent N days);
    // any earlier days fall back to the user-entered uniform assumptions.
    const fromReal = nReal > 0 && d > days - nReal;
    const ri = d - (days - nReal) - 1;
    const rain = fromReal && realDays[ri] ? realDays[ri].rain_mm + irrigationUniform : rainUniform + irrigationUniform;
    const et = (fromReal && realDays[ri] ? realDays[ri].et0_mm : fallbackEt0) * kc;
    const balance = rain - et;
    cumulative += balance;
    daily.push({
      day: d,
      rain_mm: round(rain, 1),
      et_mm: round(et, 1),
      balance_mm: round(balance, 1),
      cumulative_mm: round(cumulative, 1),
    });
  }

  const runId = newId("simrun");
  const output: SimOutput = {
    state: "SIMULATED",
    model: "AGRIFUR2 simple water balance v1.0",
    inputs: { ...inputs, et0_source: source },
    daily,
    cumulative_end_mm: round(cumulative, 1),
    source,
    ...(source === "field_climate"
      ? {
          climate: {
            days_used: nReal,
            horizon_days: days,
            note:
              nReal > 0
                ? `Daily baseline taken from this field's real recorded ET0/precipitation weather evidence (${nReal} recent model day(s)${days - nReal > 0 ? `; ${days - nReal} leading day(s) used uniform inputs` : ""}).`
                : "No ET0 weather evidence found for this field — fell back to uniform daily inputs.",
          },
        }
      : {}),
    assumptions: row.assumptions,
    limitations: row.limitations,
    disclaimer: "SIMULATED output. Not an observation, not a prediction of reality.",
  };

  db.conn
    .query("INSERT INTO simulation_runs (id, simulation_id, output, ran_at) VALUES (?,?,?,?)")
    .run(runId, row.id, JSON.stringify(output), nowIso());
  db.conn.query("UPDATE simulations SET status='completed' WHERE id = ?").run(row.id);
  addMemory(db, {
    userId,
    farmId: String(row.farm_id),
    fieldId: String(row.field_id),
    kind: "simulation_run",
    refId: runId,
    title: `Simulation run: ${row.name}`,
    summary: `Water balance simulation completed over ${days} days; end balance ${output.cumulative_end_mm} mm (SIMULATED).`,
  });
  publishEvent(db, {
    type: "EVIDENCE_ADDED",
    user_id: userId,
    farm_id: String(row.farm_id),
    field_id: String(row.field_id),
    payload: { domain: "simulation", state: "SIMULATED" },
  });
  // One simulation-domain evidence row so the world model sees the layer.
  addEvidence(db, {
    userId,
    farmId: String(row.farm_id),
    fieldId: String(row.field_id),
    domain: "simulation",
    source: "AGRIFUR2 water balance model",
    source_type: "agrifur-sim",
    sub_type: `water_balance_${days}d`,
    measurement: "Simulated cumulative water balance",
    value: output.cumulative_end_mm,
    unit: "mm",
    state: "SIMULATED",
    observed_at: nowIso(),
    description: output.disclaimer,
    provenance: {
      provider: "agrifur-sim",
      model: "AGRIFUR2 simple water balance v1.0",
      processing:
        source === "field_climate"
          ? "deterministic daily bucket model over the field's real recent ET0/precipitation evidence (labelled SIMULATED)"
          : "deterministic daily bucket model over user-provided uniform scenario inputs",
      note: "SIMULATED — never presented as observed reality.",
    },
  });
  return { runId, output };
}

/**
 * Deterministic, fully-labelled simulation: a simple daily water balance model
 * (rain + irrigation − ET0×Kc). Output rows are always state SIMULATED and the
 * record keeps assumptions + limitations. It is NEVER merged into observed
 * evidence — only linked as domain 'simulation'.
 */
export function simRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  r.get("/fields/:id/simulations", (req, res, next) => {
    try {
      const f = fld(req);
      let rows = db.conn.query("SELECT * FROM simulations WHERE field_id = ? ORDER BY created_at DESC").all(f.id) as never[];

      // Auto-starter: a field with real weather evidence but no scenarios should
      // never open as an empty page. Create ONE clearly-labelled starter scenario
      // anchored on this field's real ET0/precipitation evidence and run it once
      // (idempotent: subsequent visits find scenarios and skip). SIMULATED by
      // definition — no observed evidence is ever invented.
      if (rows.length === 0) {
        const etDays = db.conn
          .query(
            "SELECT COUNT(DISTINCT substr(observed_at,1,10)) AS n FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='et0_fao_evapotranspiration' AND value IS NOT NULL",
          )
          .get(f.id) as { n: number };
        if (Number(etDays.n) >= 3) {
          const id = newId("sim");
          const now = nowIso();
          db.conn
            .query(
              `INSERT INTO simulations (id, user_id, farm_id, field_id, name, scenario, model, model_version, inputs, assumptions, limitations, status, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              id,
              req.user!.id,
              f.farm_id,
              f.id,
              "Field climate water balance (auto · DEVELOPMENT_SEED)",
              "What-if: this field's recent real ET0 + rainfall over 30 days with no irrigation — daily baseline from recorded weather evidence (SIMULATED).",
              "AGRIFUR2 simple water balance",
              "1.0",
              JSON.stringify({ rainfall_mm: 0, irrigation_mm: 0, crop_factor_kc: 1.0, days: 30, et0_source: "field_climate" }),
              "Daily rain/ET0 from the field's real recorded weather evidence (most recent 30 days); no irrigation; no soil-moisture carry-over between days.",
              "Auto-created starter scenario (labelled DEVELOPMENT_SEED). Deterministic what-if only — SIMULATED output never enters observed evidence, risks or advisories.",
              "ready",
              now,
            );
          const row = db.conn.query("SELECT * FROM simulations WHERE id = ?").get(id) as SimRow;
          try {
            executeSimulation(db, req.user!.id, row);
          } catch (e) {
            console.warn(`[sim] auto-starter run failed for ${id}: ${e instanceof Error ? e.message : e}`);
          }
          rows = db.conn.query("SELECT * FROM simulations WHERE field_id = ? ORDER BY created_at DESC").all(f.id) as never[];
        }
      }
      res.json({ simulations: rows });
    } catch (e) {
      next(e);
    }
  });

  r.post("/fields/:id/simulations", (req, res, next) => {
    try {
      const f = fld(req);
      const body = simSchema.parse(req.body);
      const id = newId("sim");
      const inputs = {
        rainfall_mm: body.inputs?.rainfall_mm ?? 0,
        irrigation_mm: body.inputs?.irrigation_mm ?? 0,
        crop_factor_kc: body.inputs?.crop_factor_kc ?? 1.0,
        days: body.inputs?.days ?? 30,
        et0_source: body.inputs?.et0_source ?? "uniform",
      };
      db.conn
        .query(
          `INSERT INTO simulations (id, user_id, farm_id, field_id, name, scenario, model, model_version, inputs, assumptions, limitations, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          req.user!.id,
          f.farm_id,
          f.id,
          body.name,
          body.scenario,
          "AGRIFUR2 simple water balance",
          "1.0",
          JSON.stringify(inputs),
          inputs.et0_source === "field_climate"
            ? "Daily water balance: soil storage change = (real recorded precipitation + irrigation) − (real recorded ET0 × Kc). Single root-zone bucket; climate baseline from this field's weather evidence."
            : "Daily water balance: soil storage change = rainfall + irrigation − (ET0 × Kc). Single root-zone bucket; uniform field conditions assumed.",
          "No root-zone physics, no crop-growth model, no runoff/redistribution; SIMULATED output only — never presented as observed.",
          "ready",
          nowIso(),
        );
      audit(db, req.user!.id, "simulation.create", `simulation:${id}`, { et0_source: inputs.et0_source });
      const row = db.conn.query("SELECT * FROM simulations WHERE id = ?").get(id);
      res.status(201).json({ simulation: row });
    } catch (e) {
      next(e);
    }
  });

  r.post("/simulations/:id/run", (req, res, next) => {
    try {
      const row = db.conn.query("SELECT * FROM simulations WHERE id = ?").get(req.params.id) as SimRow | undefined;
      if (!row) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Simulation not found" } });
        return;
      }
      getOwnedField(db, String(row.field_id), req.user!);
      const { runId, output } = executeSimulation(db, req.user!.id, row);
      const runs = db.conn.query("SELECT id, output, ran_at FROM simulation_runs WHERE simulation_id = ? ORDER BY ran_at DESC").all(row.id);
      res.json({ run: { id: runId, output, ran_at: nowIso() }, runs: runs.map((x) => ({ ...(x as { output: string }), output: jsonParse((x as { output: string }).output, {}) })) });
    } catch (e) {
      next(e);
    }
  });

  r.get("/simulations/:id/runs", (req, res, next) => {
    try {
      const row = db.conn.query("SELECT id, field_id FROM simulations WHERE id = ?").get(req.params.id) as { id: string; field_id: string } | undefined;
      if (!row) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Simulation not found" } });
        return;
      }
      getOwnedField(db, row.field_id, req.user!);
      const runs = db.conn.query("SELECT id, output, ran_at FROM simulation_runs WHERE simulation_id = ? ORDER BY ran_at DESC").all(row.id) as { output: string }[];
      res.json({ runs: runs.map((x) => ({ ...x, output: jsonParse(x.output, {}) })) });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
