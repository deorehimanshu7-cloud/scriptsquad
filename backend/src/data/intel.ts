/**
 * Intelligence & investigation repository.
 * Persists engine outputs and case-file entities. Everything is field-scoped.
 */
import { dbAll, dbGet, dbRun, GEO } from './db';
import { generateId } from '../database/sqlite';

// ── Anomalies ───────────────────────────────────────────────────────────────
export interface AnomalyRow {
  id: string; field_id: string; type: string; subtype?: string | null;
  timestamp: string; method: string; evidence_ids: string[];
  state: string; severity: string | null; quality: unknown; geometry?: GeoJSON.Geometry | null;
  description?: string | null; created_at: string;
}

const ANOM_SELECT = `SELECT a.id, a.field_id, a.type, a.subtype, a.timestamp, a.method, a.evidence_ids,
  a.state, a.severity, a.quality, ${GEO.toJson('a.geometry', 'geometry')}, a.description, a.created_at FROM anomalies a`;

export async function insertAnomaly(input: Omit<AnomalyRow, 'created_at'>): Promise<AnomalyRow> {
  await dbRun(
    `INSERT INTO anomalies (id, field_id, type, subtype, timestamp, method, evidence_ids, state, severity, quality, geometry, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,${GEO.fromJson('$11')},$12)`,
    [input.id, input.field_id, input.type, input.subtype || null, input.timestamp, input.method,
     input.evidence_ids, input.state, input.severity, input.quality ?? null,
     input.geometry ? JSON.stringify(input.geometry) : null, input.description || null]
  );
  return (await dbGet(`${ANOM_SELECT} WHERE a.id = $1`, [input.id])) as AnomalyRow;
}

export async function anomalyExists(id: string): Promise<boolean> {
  return !!(await dbGet(`SELECT 1 AS ok FROM anomalies WHERE id = $1`, [id]));
}

export async function findAnomalyByKey(fieldId: string, type: string, subtype: string | undefined | null): Promise<AnomalyRow | null> {
  if (subtype) {
    return (await dbGet(`${ANOM_SELECT} WHERE a.field_id = $1 AND a.type = $2 AND a.subtype = $3 ORDER BY a.timestamp DESC LIMIT 1`, [fieldId, type, subtype])) as AnomalyRow | null;
  }
  return (await dbGet(`${ANOM_SELECT} WHERE a.field_id = $1 AND a.type = $2 AND a.subtype IS NULL ORDER BY a.timestamp DESC LIMIT 1`, [fieldId, type])) as AnomalyRow | null;
}

export async function listAnomalies(fieldId: string, limit = 100): Promise<AnomalyRow[]> {
  return (await dbAll(`${ANOM_SELECT} WHERE a.field_id = $1 ORDER BY a.timestamp DESC LIMIT ${limit}`, [fieldId])) as AnomalyRow[];
}

export async function setAnomalyState(id: string, state: string): Promise<void> {
  await dbRun(`UPDATE anomalies SET state = $1 WHERE id = $2`, [state, id]);
}

// ── Risks ───────────────────────────────────────────────────────────────────
export interface RiskRow {
  id: string; field_id: string; type: string; severity: string; time_horizon?: string | null;
  affected_geometry?: GeoJSON.Geometry | null; evidence_ids: string[]; status: string;
  description?: string | null; trigger_reason?: string | null; uncertainty: string; created_at: string;
}

const RISK_SELECT = `SELECT r.id, r.field_id, r.type, r.severity, r.time_horizon,
  ${GEO.toJson('r.affected_geometry', 'affected_geometry')}, r.evidence_ids, r.status,
  r.description, r.trigger_reason, r.uncertainty, r.created_at FROM risks r`;

export async function insertRisk(input: Omit<RiskRow, 'created_at'>): Promise<RiskRow> {
  await dbRun(
    `INSERT INTO risks (id, field_id, type, severity, time_horizon, affected_geometry, evidence_ids, status, description, trigger_reason, uncertainty)
     VALUES ($1,$2,$3,$4,$5,${GEO.fromJson('$6')},$7,$8,$9,$10,$11)`,
    [input.id, input.field_id, input.type, input.severity, input.time_horizon || null,
     input.affected_geometry ? JSON.stringify(input.affected_geometry) : null,
     input.evidence_ids, input.status, input.description || null, input.trigger_reason || null, input.uncertainty]
  );
  return (await dbGet(`${RISK_SELECT} WHERE r.id = $1`, [input.id])) as RiskRow;
}

export async function riskExists(id: string): Promise<boolean> {
  return !!(await dbGet(`SELECT 1 AS ok FROM risks WHERE id = $1`, [id]));
}

export async function findActiveRiskByTrigger(fieldId: string, triggerReason: string): Promise<RiskRow | null> {
  return (await dbGet(
    `${RISK_SELECT} WHERE r.field_id = $1 AND r.status = 'ACTIVE' AND r.trigger_reason = $2 ORDER BY r.created_at DESC LIMIT 1`,
    [fieldId, triggerReason]
  )) as RiskRow | null;
}

export async function listRisks(fieldId: string, activeOnly = false, limit = 100): Promise<RiskRow[]> {
  const q = activeOnly
    ? `${RISK_SELECT} WHERE r.field_id = $1 AND r.status = 'ACTIVE' ORDER BY r.created_at DESC LIMIT ${limit}`
    : `${RISK_SELECT} WHERE r.field_id = $1 ORDER BY r.created_at DESC LIMIT ${limit}`;
  return (await dbAll(q, [fieldId])) as RiskRow[];
}

export async function updateRiskStatus(id: string, status: string): Promise<void> {
  await dbRun(`UPDATE risks SET status = $1 WHERE id = $2`, [status, id]);
}

// ── Uncertainties ───────────────────────────────────────────────────────────
export async function storeUncertainty(fieldId: string, assessment: Record<string, unknown>): Promise<void> {
  await dbRun(`INSERT INTO uncertainties (id, field_id, assessment) VALUES ($1,$2,$3)`, [generateId(), fieldId, assessment]);
}
export async function latestUncertainty(fieldId: string): Promise<any | null> {
  return dbGet(`SELECT * FROM uncertainties WHERE field_id = $1 ORDER BY created_at DESC LIMIT 1`, [fieldId]);
}
export async function listUncertainties(fieldId: string, limit = 50): Promise<any[]> {
  return dbAll(`SELECT * FROM uncertainties WHERE field_id = $1 ORDER BY created_at DESC LIMIT ${limit}`, [fieldId]);
}

// ── Contradictions ──────────────────────────────────────────────────────────
export interface ContradictionRow {
  id: string; field_id: string; type: string; description: string;
  evidence_a_id?: string | null; evidence_b_id?: string | null;
  source_a?: string | null; source_b?: string | null;
  detected_at: string; state: string; severity: string; hypothesis?: string | null;
}

export async function insertContradiction(input: Omit<ContradictionRow, 'detected_at'>): Promise<ContradictionRow> {
  await dbRun(
    `INSERT INTO contradictions (id, field_id, type, description, evidence_a_id, evidence_b_id, source_a, source_b, state, severity, hypothesis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [input.id, input.field_id, input.type, input.description, input.evidence_a_id || null,
     input.evidence_b_id || null, input.source_a || null, input.source_b || null,
     input.state, input.severity, input.hypothesis || null]
  );
  return (await dbGet(`SELECT * FROM contradictions WHERE id = $1`, [input.id])) as ContradictionRow;
}

export async function findContradictionByPair(fieldId: string, type: string, a?: string | null, b?: string | null): Promise<ContradictionRow | null> {
  if (a && b) {
    return (await dbGet(`SELECT * FROM contradictions WHERE field_id = $1 AND type = $2 AND evidence_a_id = $3 AND evidence_b_id = $4 LIMIT 1`, [fieldId, type, a, b])) as ContradictionRow | null;
  }
  return (await dbGet(`SELECT * FROM contradictions WHERE field_id = $1 AND type = $2 AND evidence_a_id IS NULL AND evidence_b_id IS NULL LIMIT 1`, [fieldId, type])) as ContradictionRow | null;
}

export async function listContradictions(fieldId: string, activeOnly = true, limit = 100): Promise<ContradictionRow[]> {
  const q = activeOnly
    ? `SELECT * FROM contradictions WHERE field_id = $1 AND state IN ('DETECTED','INVESTIGATING') ORDER BY detected_at DESC LIMIT ${limit}`
    : `SELECT * FROM contradictions WHERE field_id = $1 ORDER BY detected_at DESC LIMIT ${limit}`;
  return (await dbAll(q, [fieldId])) as ContradictionRow[];
}

// ── Investigations ───────────────────────────────────────────────────────────
export interface InvestigationRow {
  id: string; field_id: string; user_id: string; title: string; question: string;
  trigger_type: string; trigger_data: Record<string, unknown>; status: string;
  hypotheses: any[]; evidence_ids: string[]; supporting_ids: string[]; conflicting_ids: string[];
  missing: string[]; next_observations: any[]; conclusion?: string | null;
  action_recommendation?: string | null; created_at: string; updated_at: string;
}

const INV_SELECT = `SELECT i.id, i.field_id, i.user_id, i.title, i.question, i.trigger_type,
  i.trigger_data, i.status, i.hypotheses, i.evidence_ids, i.supporting_ids, i.conflicting_ids,
  i.missing, i.next_observations, i.conclusion, i.action_recommendation, i.created_at, i.updated_at
  FROM investigations i`;

export async function createInvestigation(input: {
  fieldId: string; userId: string; title: string; question?: string; triggerType?: string;
  triggerData?: Record<string, unknown>; evidenceIds?: string[];
}): Promise<InvestigationRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO investigations (id, field_id, user_id, title, question, trigger_type, trigger_data, evidence_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.fieldId, input.userId, input.title, input.question || '', input.triggerType || 'MANUAL',
     input.triggerData || {}, input.evidenceIds || []]
  );
  return (await dbGet(`${INV_SELECT} WHERE i.id = $1`, [id])) as InvestigationRow;
}

export async function listInvestigations(fieldId: string, userId: string): Promise<InvestigationRow[]> {
  return (await dbAll(`${INV_SELECT} WHERE i.field_id = $1 AND i.user_id = $2 ORDER BY i.updated_at DESC`, [fieldId, userId])) as InvestigationRow[];
}

export async function getInvestigation(investigationId: string, fieldId: string, userId: string): Promise<InvestigationRow | null> {
  return (await dbGet(`${INV_SELECT} WHERE i.id = $1 AND i.field_id = $2 AND i.user_id = $3`, [investigationId, fieldId, userId])) as InvestigationRow | null;
}

export async function getInvestigationAnyOwner(investigationId: string, fieldId: string): Promise<InvestigationRow | null> {
  return (await dbGet(`${INV_SELECT} WHERE i.id = $1 AND i.field_id = $2`, [investigationId, fieldId])) as InvestigationRow | null;
}

export async function updateInvestigation(investigationId: string, patch: Partial<Pick<InvestigationRow, 'title' | 'question' | 'status' | 'conclusion' | 'action_recommendation'>> & {
  hypotheses?: any[]; evidence_ids?: string[]; supporting_ids?: string[]; conflicting_ids?: string[];
  missing?: string[]; next_observations?: any[];
}): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  const cols: Record<string, any> = {
    title: patch.title, question: patch.question, status: patch.status, conclusion: patch.conclusion,
    action_recommendation: patch.action_recommendation, hypotheses: patch.hypotheses,
    evidence_ids: patch.evidence_ids, supporting_ids: patch.supporting_ids,
    conflicting_ids: patch.conflicting_ids, missing: patch.missing, next_observations: patch.next_observations,
  };
  for (const [k, v] of Object.entries(cols)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  if (sets.length === 0) return;
  params.push(new Date().toISOString());
  await dbRun(`UPDATE investigations SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, investigationId]);
}

export async function addHypothesisToInvestigation(investigationId: string, hypothesis: any): Promise<void> {
  const row = (await dbGet(`SELECT hypotheses FROM investigations WHERE id = $1`, [investigationId])) as any;
  const list = Array.isArray(row?.hypotheses) ? row.hypotheses : [];
  list.push(hypothesis);
  await dbRun(`UPDATE investigations SET hypotheses = $1, updated_at = $2 WHERE id = $3`, [list, new Date().toISOString(), investigationId]);
}

// ── Hypotheses table (relational mirror) ────────────────────────────────────
export async function insertHypothesisRow(input: { investigationId: string; description: string; supporting?: string[]; conflicting?: string[]; missing?: string[]; nextObservation?: string; status?: string }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO hypotheses (id, investigation_id, description, supporting_evidence, conflicting_evidence, missing_evidence, next_observation, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, input.investigationId, input.description, input.supporting || [], input.conflicting || [],
     input.missing || [], input.nextObservation || null, input.status || 'PROPOSED']
  );
  return dbGet(`SELECT * FROM hypotheses WHERE id = $1`, [id]);
}

export async function listHypothesisRows(investigationId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM hypotheses WHERE investigation_id = $1 ORDER BY created_at`, [investigationId]);
}

// ── Next best observations table ────────────────────────────────────────────
export async function insertNboRow(input: { investigationId: string; candidate: string; rationale?: string; priority?: string; cost?: string; delay?: string }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO next_best_observations (id, investigation_id, candidate, rationale, priority, cost, delay)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.investigationId, input.candidate, input.rationale || null, input.priority || 'MEDIUM', input.cost || null, input.delay || null]
  );
  return dbGet(`SELECT * FROM next_best_observations WHERE id = $1`, [id]);
}

export async function listNboRows(investigationId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM next_best_observations WHERE investigation_id = $1 ORDER BY created_at`, [investigationId]);
}

// ── Farmer observations ─────────────────────────────────────────────────────
export async function createFarmerObservation(input: {
  userId: string; farmId: string; fieldId: string; text: string; location?: GeoJSON.Point | null;
}): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO farmer_observations (id, user_id, farm_id, field_id, text, location)
     VALUES ($1,$2,$3,$4,$5,${GEO.fromJson('$6')})`,
    [id, input.userId, input.farmId, input.fieldId, input.text, input.location ? JSON.stringify(input.location) : null]
  );
  return dbGet(`SELECT * FROM farmer_observations WHERE id = $1`, [id]);
}

export async function listFarmerObservations(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM farmer_observations WHERE field_id = $1 ORDER BY created_at DESC`, [fieldId]);
}

export async function setFarmerObservationVerification(id: string, verification: string, corroboratingIds: string[]): Promise<void> {
  await dbRun(`UPDATE farmer_observations SET verification = $1, corroborating_evidence_ids = $2 WHERE id = $3`,
    [verification, corroboratingIds, id]);
}

// ── Verifications / Farm memory ─────────────────────────────────────────────
export async function createVerification(input: { fieldId: string; entityType: string; entityId: string; expectedOutcome?: Record<string, unknown> }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO verifications (id, field_id, entity_type, entity_id, expected_outcome)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, input.fieldId, input.entityType, input.entityId, input.expectedOutcome || {}]
  );
  return dbGet(`SELECT * FROM verifications WHERE id = $1`, [id]);
}

export async function completeVerification(input: { id: string; actualOutcome: Record<string, unknown>; evidenceIds: string[]; result: string }): Promise<any | null> {
  await dbRun(
    `UPDATE verifications SET actual_outcome = $1, evidence_ids = $2, result = $3, verified_at = $4 WHERE id = $5`,
    [input.actualOutcome, input.evidenceIds, input.result, new Date().toISOString(), input.id]
  );
  return dbGet(`SELECT * FROM verifications WHERE id = $1`, [input.id]);
}

export async function listVerifications(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM verifications WHERE field_id = $1 ORDER BY created_at DESC`, [fieldId]);
}

export async function createFarmMemory(input: { fieldId: string; event: string; evidenceIds?: string[]; reasoning?: string; action?: string; expectedOutcome?: Record<string, unknown>; actualOutcome?: Record<string, unknown>; verificationResult?: string; learnedRule?: string }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO farm_memory (id, field_id, event, evidence_ids, reasoning, action, expected_outcome, actual_outcome, verification_result, learned_rule)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, input.fieldId, input.event, input.evidenceIds || [], input.reasoning || null, input.action || null,
     input.expectedOutcome || {}, input.actualOutcome || {}, input.verificationResult || null, input.learnedRule || null]
  );
  return dbGet(`SELECT * FROM farm_memory WHERE id = $1`, [id]);
}

export async function listFarmMemory(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM farm_memory WHERE field_id = $1 ORDER BY created_at DESC`, [fieldId]);
}

// ── Simulations ─────────────────────────────────────────────────────────────
export async function createSimulation(input: { fieldId: string; userId: string; name: string; scenario: Record<string, unknown>; assumptions: string[] }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO simulations (id, field_id, user_id, name, scenario, assumptions) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.fieldId, input.userId, input.name, input.scenario, input.assumptions]
  );
  return dbGet(`SELECT * FROM simulations WHERE id = $1`, [id]);
}

export async function listSimulations(fieldId: string, userId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM simulations WHERE field_id = $1 AND user_id = $2 ORDER BY created_at DESC`, [fieldId, userId]);
}

export async function getSimulation(id: string, fieldId: string, userId: string): Promise<any | null> {
  return dbGet(`SELECT * FROM simulations WHERE id = $1 AND field_id = $2 AND user_id = $3`, [id, fieldId, userId]);
}

export async function updateSimulation(id: string, patch: { status?: string; result?: Record<string, unknown>; executedAt?: string }): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`); }
  if (patch.result !== undefined) { params.push(patch.result); sets.push(`result = $${params.length}`); }
  if (patch.executedAt !== undefined) { params.push(patch.executedAt); sets.push(`executed_at = $${params.length}`); }
  params.push(new Date().toISOString());
  if (sets.length === 0) return;
  await dbRun(`UPDATE simulations SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, id]);
}
