import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonStringify, newId } from "../util";
import { getFieldRow } from "./worldModel";
import { publishEvent } from "./events";
import { addMemory } from "./memory";

/**
 * Investigation engine. Investigations are always grounded: they are created
 * from real open anomalies, risks, contradictions or farmer reports, and their
 * hypotheses / next-observations are derived from what evidence is missing
 * (never invented conclusions).
 */

export interface InvestigationDetail {
  id: string;
  field_id: string;
  title: string;
  problem: string;
  status: string;
  trigger: string | null;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  evidence: { id: string; domain: string; sub_type: string; state: string; value: number | null; unit: string | null; observed_at: string }[];
  hypotheses: { id: string; statement: string; status: string; tested_with: string | null; created_at: string }[];
  next_observations: { id: string; rank: string; observation: string; reason: string; status: string; created_at: string }[];
}

export function listInvestigations(db: AppDb, fieldId: string): InvestigationDetail[] {
  const rows = db.conn
    .query("SELECT * FROM investigations WHERE field_id = ? ORDER BY created_at DESC LIMIT 50")
    .all(fieldId) as unknown as InvestigationDetail[];
  return rows.map((r) => decorate(db, r));
}

export function getInvestigation(db: AppDb, fieldId: string, id: string): InvestigationDetail | null {
  const row = db.conn
    .query("SELECT * FROM investigations WHERE id = ? AND field_id = ?")
    .get(id, fieldId) as unknown as InvestigationDetail | undefined;
  return row ? decorate(db, row) : null;
}

function decorate(db: AppDb, inv: InvestigationDetail): InvestigationDetail {
  const evidence = db.conn
    .query(
      `SELECT e.id, e.domain, e.sub_type, e.state, e.value, e.unit, e.observed_at
       FROM investigation_evidence ie JOIN evidence e ON e.id = ie.evidence_id
       WHERE ie.investigation_id = ? ORDER BY e.observed_at DESC LIMIT 40`,
    )
    .all(inv.id) as { id: string; domain: string; sub_type: string; state: string; value: number | null; unit: string | null; observed_at: string }[];
  const hypotheses = db.conn
    .query("SELECT id, statement, status, tested_with, created_at FROM hypotheses WHERE investigation_id = ? ORDER BY created_at ASC")
    .all(inv.id) as { id: string; statement: string; status: string; tested_with: string | null; created_at: string }[];
  const next_observations = db.conn
    .query("SELECT id, rank, observation, reason, status, created_at FROM next_observations WHERE investigation_id = ? ORDER BY rank, created_at ASC")
    .all(inv.id) as { id: string; rank: string; observation: string; reason: string; status: string; created_at: string }[];
  return { ...inv, evidence, hypotheses, next_observations };
}

export interface InvestigationInput {
  userId: string;
  farmId: string;
  fieldId: string;
  title: string;
  problem: string;
  trigger?: string | null;
  evidenceIds?: string[];
}

export function createInvestigation(db: AppDb, input: InvestigationInput): InvestigationDetail {
  const id = newId("inv");
  db.conn
    .query(
      "INSERT INTO investigations (id, user_id, farm_id, field_id, title, problem, status, trigger, conclusion, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(id, input.userId, input.farmId, input.fieldId, input.title, input.problem, "collecting_evidence", input.trigger ?? null, null, nowIso(), nowIso());
  for (const eid of input.evidenceIds ?? []) {
    db.conn
      .query("INSERT OR IGNORE INTO investigation_evidence (investigation_id, evidence_id, role, created_at) VALUES (?,?,?,?)")
      .run(id, eid, "trigger", nowIso());
  }
  const detail = getInvestigation(db, input.fieldId, id);
  if (detail) {
    addMemory(db, {
      userId: input.userId,
      farmId: input.farmId,
      fieldId: input.fieldId,
      kind: "investigation_resolved",
      refId: id,
      title: `Investigation opened: ${input.title}`,
      summary: input.problem.slice(0, 200),
    });
    publishEvent(db, {
      type: "INVESTIGATION_UPDATED",
      user_id: input.userId,
      farm_id: input.farmId,
      field_id: input.fieldId,
      payload: { investigation_id: id, status: "collecting_evidence" },
    });
  }
  return detail!;
}

/** Generate candidate hypotheses from the field's real open evidence conflicts. */
export function generateHypotheses(db: AppDb, fieldId: string): { statement: string; rationale: string }[] {
  const out: { statement: string; rationale: string }[] = [];

  const contradictions = db.conn
    .query("SELECT reason FROM contradictions WHERE field_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 3")
    .all(fieldId) as { reason: string }[];
  for (const c of contradictions) {
    out.push({
      statement: `A recorded contradiction may indicate a faulty sensor or a locally different condition.`,
      rationale: `Based on open contradiction: ${c.reason}`,
    });
  }

  const anomalies = db.conn
    .query("SELECT kind, description FROM anomalies WHERE field_id = ? AND status = 'open' ORDER BY detected_at DESC LIMIT 3")
    .all(fieldId) as { kind: string; description: string }[];
  for (const a of anomalies) {
    if (a.kind === "sensor_spike") {
      out.push({
        statement: "The sensor spike may be caused by a device fault or disturbed deployment rather than a real field condition.",
        rationale: `Based on anomaly: ${a.description}`,
      });
    }
    if (a.kind === "heavy_rainfall") {
      out.push({
        statement: "Heavy rainfall may have caused waterlogging or nutrient leaching in low areas of the field.",
        rationale: `Based on anomaly: ${a.description}`,
      });
    }
  }

  const waterRisk = db.conn
    .query("SELECT level, reason FROM risks WHERE field_id = ? AND risk_type = 'water_stress' ORDER BY created_at DESC LIMIT 1")
    .get(fieldId) as { level: string; reason: string } | undefined;
  if (waterRisk && waterRisk.level !== "LOW") {
    out.push({
      statement: "Crops may currently be under water stress; check soil moisture and irrigation records before acting.",
      rationale: `Based on water_stress risk ${waterRisk.level}: ${waterRisk.reason}`,
    });
  }

  const soilMissing = db.conn
    .query("SELECT COUNT(*) as n FROM evidence WHERE field_id = ? AND domain = 'soil'")
    .get(fieldId) as { n: number };
  if (soilMissing.n === 0) {
    out.push({
      statement: "Soil conditions are UNKNOWN because no soil evidence exists for this field.",
      rationale: "No soil model estimates or measurements are recorded.",
    });
  }

  if (out.length === 0) {
    out.push({
      statement: "No strong hypothesis can be formed from current evidence — more observations are needed.",
      rationale: "No open contradictions, anomalies or non-trivial risks are recorded for this field.",
    });
  }
  return out;
}

/** Next observations ranked by how much they reduce the evidence gap (information-gain proxy). */
export function generateNextObservations(db: AppDb, fieldId: string): { rank: "HIGH" | "MEDIUM" | "LOW"; observation: string; reason: string }[] {
  const out: { rank: "HIGH" | "MEDIUM" | "LOW"; observation: string; reason: string }[] = [];

  const moisture = db.conn
    .query("SELECT COUNT(*) as n FROM observations WHERE field_id = ? AND sensor_type = 'soil_moisture'")
    .get(fieldId) as { n: number };
  if (moisture.n === 0) {
    out.push({
      rank: "HIGH",
      observation: "Check whether a soil-moisture sensor is deployed and reporting; if none exists, take a manual soil sample.",
      reason: "Water-stress evaluation is currently based only on the atmospheric balance; root-zone truth is missing.",
    });
  }

  const farmerReports = db.conn.query("SELECT COUNT(*) as n FROM farmer_observations WHERE field_id = ?").get(fieldId) as { n: number };
  if (farmerReports.n === 0) {
    out.push({
      rank: "MEDIUM",
      observation: "Ask the farmer what they observe in the field today (pest, colour, standing water, irrigation events).",
      reason: "Farmer input is a required evidence layer and none is recorded yet.",
    });
  }

  const satellites = db.conn.query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ?").get(fieldId) as { n: number };
  if (satellites.n === 0) {
    out.push({
      rank: "MEDIUM",
      observation: "Wait for the next scheduled satellite discovery run, or trigger a manual discovery.",
      reason: "No acquisition metadata is recorded; vegetation change cannot be evaluated without imagery evidence.",
    });
  }

  const weatherFresh = db.conn
    .query("SELECT MAX(retrieved_at) as last FROM evidence WHERE field_id = ? AND domain = 'weather'")
    .get(fieldId) as { last: string | null };
  if (weatherFresh.last && Date.now() - new Date(weatherFresh.last).getTime() > 36 * 3_600_000) {
    out.push({
      rank: "LOW",
      observation: "Weather evidence is stale — refresh it.",
      reason: "Latest weather retrieval is older than the 36h freshness target.",
    });
  }

  if (out.length === 0) {
    out.push({
      rank: "LOW",
      observation: "All evidence layers are populated and fresh — no urgent observation is required.",
      reason: "No evidence gaps found for this field.",
    });
  }
  return out;
}

/** Attach generated hypotheses + next observations to an investigation (idempotent when empty). */
export function enrichInvestigation(db: AppDb, fieldId: string, investigationId: string): void {
  const existing = db.conn.query("SELECT COUNT(*) as n FROM hypotheses WHERE investigation_id = ?").get(investigationId) as { n: number };
  if (existing.n === 0) {
    for (const h of generateHypotheses(db, fieldId)) {
      db.conn
        .query("INSERT INTO hypotheses (id, investigation_id, statement, status, tested_with, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(newId("hyp"), investigationId, `${h.statement} (${h.rationale})`, "proposed", null, nowIso(), nowIso());
    }
  }
  const nextExisting = db.conn.query("SELECT COUNT(*) as n FROM next_observations WHERE investigation_id = ?").get(investigationId) as { n: number };
  if (nextExisting.n === 0) {
    for (const n of generateNextObservations(db, fieldId)) {
      db.conn
        .query("INSERT INTO next_observations (id, investigation_id, rank, observation, reason, status, created_at) VALUES (?,?,?,?,?,?,?)")
        .run(newId("nobs"), investigationId, n.rank, n.observation, n.reason, "open", nowIso());
    }
  }
}

export function updateInvestigation(
  db: AppDb,
  fieldId: string,
  id: string,
  patch: { status?: string; conclusion?: string | null },
): InvestigationDetail | null {
  const existing = getInvestigation(db, fieldId, id);
  if (!existing) return null;
  const status = patch.status ?? existing.status;
  const conclusion = patch.conclusion !== undefined ? patch.conclusion : existing.conclusion;
  db.conn
    .query("UPDATE investigations SET status = ?, conclusion = ?, updated_at = ? WHERE id = ?")
    .run(status, conclusion, nowIso(), id);
  if (status === "resolved" && conclusion) {
    const field = getFieldRow(db, fieldId);
    if (field) {
      addMemory(db, {
        userId: field.user_id,
        farmId: field.farm_id,
        fieldId,
        kind: "investigation_resolved",
        refId: id,
        title: `Investigation resolved: ${existing.title}`,
        summary: conclusion.slice(0, 200),
      });
    }
  }
  publishEvent(db, {
    type: "INVESTIGATION_UPDATED",
    field_id: fieldId,
    payload: { investigation_id: id, status },
  });
  return getInvestigation(db, fieldId, id);
}

/** Auto-open an investigation from a triggered anomaly/contradiction. */
export function autoInvestigate(db: AppDb, fieldId: string, trigger: { kind: string; description: string; evidenceIds: string[] }): InvestigationDetail | null {
  const existing = db.conn
    .query("SELECT id FROM investigations WHERE field_id = ? AND trigger = ? AND status IN ('open','collecting_evidence','hypothesis_testing') ORDER BY created_at DESC LIMIT 1")
    .get(fieldId, trigger.kind) as { id: string } | undefined;
  if (existing) return getInvestigation(db, fieldId, existing.id);

  const field = getFieldRow(db, fieldId);
  if (!field) return null;
  const title = `Investigate: ${trigger.kind.replace(/_/g, " ")}`;
  const detail = createInvestigation(db, {
    userId: field.user_id,
    farmId: field.farm_id,
    fieldId,
    title,
    problem: trigger.description,
    trigger: trigger.kind,
    evidenceIds: trigger.evidenceIds,
  });
  enrichInvestigation(db, fieldId, detail.id);
  return detail;
}

export function createHypothesis(db: AppDb, fieldId: string, investigationId: string, statement: string): void {
  db.conn
    .query("INSERT INTO hypotheses (id, investigation_id, statement, status, tested_with, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(newId("hyp"), investigationId, statement, "proposed", null, nowIso(), nowIso());
  db.conn.query("UPDATE investigations SET status='hypothesis_testing', updated_at=? WHERE id=? AND field_id=?").run(nowIso(), investigationId, fieldId);
}

export function setHypothesisStatus(db: AppDb, investigationId: string, hypothesisId: string, status: string): void {
  db.conn
    .query("UPDATE hypotheses SET status = ?, tested_with = ?, updated_at = ? WHERE id = ?")
    .run(status, status === "supported" || status === "rejected" ? "recorded evidence" : null, nowIso(), hypothesisId);
  if (status === "supported" || status === "rejected") {
    const inv = db.conn.query("SELECT field_id FROM investigations WHERE id = ?").get(investigationId) as { field_id: string } | undefined;
    if (inv) {
      const open = db.conn
        .query("SELECT COUNT(*) as n FROM hypotheses WHERE investigation_id = ? AND status IN ('proposed','testing')")
        .get(investigationId) as { n: number };
      if (open.n === 0) {
        db.conn.query("UPDATE investigations SET status='resolved', updated_at=? WHERE id=?").run(nowIso(), investigationId);
      }
    }
  }
}

export function addNextObservation(db: AppDb, investigationId: string, rank: string, observation: string, reason: string): void {
  db.conn
    .query("INSERT INTO next_observations (id, investigation_id, rank, observation, reason, status, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(newId("nobs"), investigationId, rank, observation, reason, "open", nowIso());
}

export function resolveOpenContradictionEvidence(db: AppDb, fieldId: string): void {
  // mark stale open contradictions as investigated when their evidence changed
  db.conn
    .query(
      `UPDATE contradictions SET status='resolved', updated_at=?
       WHERE field_id=? AND status='open'
         AND (evidence_a NOT IN (SELECT id FROM evidence WHERE field_id=?) OR evidence_b NOT IN (SELECT id FROM evidence WHERE field_id=?))`,
    )
    .run(nowIso(), fieldId, fieldId, fieldId);
}

export function evidenceJson(ids: string[]): string {
  return jsonStringify(ids);
}