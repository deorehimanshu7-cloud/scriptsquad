import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import {
  createInvestigation, listInvestigations, getInvestigation, getInvestigationAnyOwner,
  updateInvestigation, addHypothesisToInvestigation, insertHypothesisRow, listHypothesisRows,
  listContradictions, listNboRows,
} from '../data/intel';
import { listEvidence } from '../data/evidence';
import { suggestNextObservations } from '../services/intelligence/next-best-observation';
import { emitEvent } from '../services/events';
import { generateId } from '../database/sqlite';

const router = Router({ mergeParams: true });

router.get('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listInvestigations(req.fieldContext!.fieldId, req.user!.id);
  res.json({ success: true, data: rows, total: rows.length });
});

router.post('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { title, question, description, trigger_type, trigger_data } = req.body || {};
    if (!title && !question) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'title (or question) is required' } });
    }
    const evidence = await listEvidence({ fieldId: req.fieldContext!.fieldId, userId: req.user!.id, limit: 1000 });
    // Supporting/conflicting/missing classification from evidence
    const contradictions = await listContradictions(req.fieldContext!.fieldId, true);
    const conflictEvidenceIds = new Set<string>();
    for (const c of contradictions) {
      if (c.evidence_a_id) conflictEvidenceIds.add(c.evidence_a_id);
      if (c.evidence_b_id) conflictEvidenceIds.add(c.evidence_b_id);
    }
    const supportingIds = evidence.filter((e) => !conflictEvidenceIds.has(e.id)).slice(0, 50).map((e) => e.id);
    const conflictingIds = evidence.filter((e) => conflictEvidenceIds.has(e.id)).slice(0, 50).map((e) => e.id);
    const presentSources = new Set(evidence.map((e) => e.source));
    const allSources = ['EARTH_OBSERVATION', 'PHYSICAL_HARDWARE', 'ENVIRONMENT', 'WATER', 'AGRICULTURE', 'FARMER_INPUT'];
    const missing = allSources.filter((s) => !presentSources.has(s));
    const nextObs = await suggestNextObservations(req.fieldContext!.fieldId);

    const row = await createInvestigation({
      fieldId: req.fieldContext!.fieldId,
      userId: req.user!.id,
      title: title || question,
      question: question || '',
      triggerType: trigger_type || (contradictions.length > 0 ? 'CONTRADICTION_DETECTED' : 'MANUAL'),
      triggerData: trigger_data || { description: description || '', contradiction_count: contradictions.length },
      evidenceIds: evidence.slice(0, 100).map((e) => e.id),
    });
    await updateInvestigation(row.id, {
      supporting_ids: supportingIds,
      conflicting_ids: conflictingIds,
      missing,
      next_observations: nextObs,
    });
    await emitEvent('INVESTIGATION_CREATED', { investigation_id: row.id, title: row.title }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    const full = await getInvestigation(row.id, row.field_id, req.user!.id);
    res.status(201).json({ success: true, data: full });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:investigationId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const row = await getInvestigation(req.params.investigationId, req.fieldContext!.fieldId, req.user!.id);
  if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
  const hypothesisRows = await listHypothesisRows(row.id);
  const nboRows = await listNboRows(row.id);
  res.json({ success: true, data: { ...row, hypothesis_table: hypothesisRows, nbo_table: nboRows } });
});

router.post('/:investigationId/hypotheses', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const row = await getInvestigationAnyOwner(req.params.investigationId, req.fieldContext!.fieldId);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
    const { description } = req.body || {};
    if (!description) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Hypothesis description is required' } });
    // Evidence-derived hypothesis structure (supporting/conflicting/missing from evidence)
    const evidence = await listEvidence({ fieldId: row.field_id, userId: req.user!.id, limit: 1000 });
    const contradictions = await listContradictions(row.field_id, true);
    const conflictIds = new Set<string>();
    contradictions.forEach((c) => { if (c.evidence_a_id) conflictIds.add(c.evidence_a_id); if (c.evidence_b_id) conflictIds.add(c.evidence_b_id); });
    const supporting = evidence.filter((e) => !conflictIds.has(e.id)).map((e) => e.id).slice(0, 30);
    const conflicting = evidence.filter((e) => conflictIds.has(e.id)).map((e) => e.id).slice(0, 30);
    const sourcesPresent = new Set(evidence.map((e) => e.source));
    const allSources = ['EARTH_OBSERVATION', 'PHYSICAL_HARDWARE', 'ENVIRONMENT', 'WATER', 'AGRICULTURE', 'FARMER_INPUT'];
    const missing = allSources.filter((s) => !sourcesPresent.has(s));
    const nextObs = await suggestNextObservations(row.field_id);
    const hypothesis = {
      id: generateId(), description, status: 'PROPOSED', probability: null,
      supporting_evidence: supporting, conflicting_evidence: conflicting,
      missing_evidence: missing, next_observation: nextObs[0]?.candidate || null,
      created_at: new Date().toISOString(),
    };
    await addHypothesisToInvestigation(row.id, hypothesis);
    await insertHypothesisRow({
      investigationId: row.id, description, supporting, conflicting, missing,
      nextObservation: hypothesis.next_observation || undefined, status: 'PROPOSED',
    });
    await emitEvent('HYPOTHESIS_CREATED', { investigation_id: row.id, hypothesis_id: hypothesis.id }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    res.status(201).json({ success: true, data: hypothesis });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/:investigationId/evidence', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const row = await getInvestigationAnyOwner(req.params.investigationId, req.fieldContext!.fieldId);
  if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
  const { evidence_id } = req.body || {};
  const existing = await listEvidence({ fieldId: row.field_id, userId: req.user!.id, limit: 1000 });
  if (!existing.some((e) => e.id === evidence_id)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'evidence_id does not belong to this field' } });
  }
  const ids = new Set([...(row.evidence_ids || []), evidence_id]);
  await updateInvestigation(row.id, { evidence_ids: Array.from(ids) });
  res.json({ success: true, data: await getInvestigation(row.id, row.field_id, req.user!.id) });
});

router.get('/:investigationId/next-observations', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const row = await getInvestigation(req.params.investigationId, req.fieldContext!.fieldId, req.user!.id);
  if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
  const suggestions = await suggestNextObservations(row.field_id);
  const existing = row.next_observations || [];
  const combined = mergeNbo(existing, suggestions);
  await updateInvestigation(row.id, { next_observations: combined });
  res.json({ success: true, data: combined });
});

router.post('/:investigationId/resolve', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const row = await getInvestigation(req.params.investigationId, req.fieldContext!.fieldId, req.user!.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
    const { conclusion, action_recommendation } = req.body || {};
    await updateInvestigation(row.id, {
      status: 'RESOLVED',
      conclusion: conclusion || row.conclusion || 'No conclusion recorded.',
      action_recommendation,
    });
    await emitEvent('INVESTIGATION_RESOLVED', { investigation_id: row.id }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    res.json({ success: true, data: await getInvestigation(row.id, row.field_id, req.user!.id) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/:investigationId/escalate', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const row = await getInvestigation(req.params.investigationId, req.fieldContext!.fieldId, req.user!.id);
  if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Investigation not found' } });
  await updateInvestigation(row.id, { status: 'ESCALATED' });
  res.json({ success: true, data: await getInvestigation(row.id, row.field_id, req.user!.id) });
});

function mergeNbo(existing: any[], fresh: any[]): any[] {
  const seen = new Set<string>();
  const out: any[] = [];
  for (const n of existing) {
    if (!seen.has(n.candidate)) { seen.add(n.candidate); out.push(n); }
  }
  for (const n of fresh) {
    if (!seen.has(n.candidate)) { seen.add(n.candidate); out.push(n); }
  }
  return out.slice(0, 20);
}

export default router;
