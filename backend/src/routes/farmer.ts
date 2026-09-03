/**
 * Farmer observations & verification.
 * Farmer input starts UNVERIFIED. It becomes CORROBORATED only when evidence
 * supports it; contradicting evidence marks it CONTRADICTED. Never automatic.
 */
import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import {
  createFarmerObservation, listFarmerObservations, setFarmerObservationVerification,
  createVerification, completeVerification, listVerifications, createFarmMemory, listFarmMemory,
} from '../data/intel';
import { listEvidence } from '../data/evidence';
import { getField, getFieldFarm } from '../data/fields';
import { emitEvent } from '../services/events';

const router = Router();

router.post('/farmer-observations', authenticate, async (req: any, res: Response) => {
  try {
    const { field_id, text, location } = req.body || {};
    if (!field_id || !text) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'field_id and text are required' } });
    const field = await getField(field_id, req.user!.id);
    if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    const row = await createFarmerObservation({
      userId: req.user!.id, farmId: field.farm_id, fieldId: field_id, text,
      location: location?.type === 'Point' ? location : null,
    });
    await emitEvent('EVIDENCE_ADDED', { farmer_observation_id: row.id, verification: 'UNVERIFIED' }, { fieldId: field_id, userId: req.user!.id }).catch(() => {});
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:fieldId/farmer-observations', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listFarmerObservations(req.fieldContext!.fieldId);
  res.json({ success: true, data: rows, total: rows.length });
});

router.post('/farmer-observations/:id/verify', authenticate, async (req: any, res: Response) => {
  try {
    const { corroborating_evidence_ids, verdict } = req.body || {};
    const all = await listFarmerObservationsForUser(req.user!.id);
    const row = all.find((r: any) => r.id === req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Farmer observation not found' } });
    const ids = Array.isArray(corroborating_evidence_ids) ? corroborating_evidence_ids : [];
    const fieldEvidence = await listEvidence({ fieldId: row.field_id, userId: req.user!.id, limit: 1000 });
    const validIds = ids.filter((id: string) => fieldEvidence.some((e) => e.id === id));
    if (verdict === 'CORROBORATED' && validIds.length === 0) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Cannot mark CORROBORATED without supporting evidence. Farmer input is UNVERIFIED until corroborated.' } });
    }
    const verification = verdict === 'CONTRADICTED' ? 'CONTRADICTED' : validIds.length > 0 ? 'CORROBORATED' : 'UNVERIFIED';
    await setFarmerObservationVerification(row.id, verification, validIds);
    await emitEvent('VERIFICATION_COMPLETED', { farmer_observation_id: row.id, verification }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    res.json({ success: true, data: { id: row.id, verification, corroborating_evidence_ids: validIds } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

async function listFarmerObservationsForUser(userId: string) {
  const { dbAll } = await import('../data/db');
  return dbAll(`SELECT * FROM farmer_observations WHERE user_id = $1`, [userId]);
}

// ── Verifications & outcomes ────────────────────────────────────────────────
router.get('/:fieldId/verifications', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listVerifications(req.fieldContext!.fieldId);
  res.json({ success: true, data: rows, total: rows.length });
});

router.get('/:fieldId/outcomes', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const verifications = await listVerifications(req.fieldContext!.fieldId);
  const memory = await listFarmMemory(req.fieldContext!.fieldId);
  res.json({ success: true, data: { verifications, farm_memory: memory } });
});

router.post('/:fieldId/verifications', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { entity_type, entity_id, expected_outcome } = req.body || {};
    if (!entity_type || !entity_id) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'entity_type and entity_id are required' } });
    const row = await createVerification({
      fieldId: req.fieldContext!.fieldId, entityType: entity_type, entityId: entity_id,
      expectedOutcome: expected_outcome || {},
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/verifications/:id/complete', authenticate, async (req: any, res: Response) => {
  try {
    const { actual_outcome, evidence_ids, result } = req.body || {};
    const rows = await listVerificationsForUser(req.user!.id);
    const row = rows.find((r: any) => r.id === req.params.id);
    if (!row) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Verification not found' } });
    const completed = await completeVerification({
      id: row.id, actualOutcome: actual_outcome || {}, evidenceIds: Array.isArray(evidence_ids) ? evidence_ids : [],
      result: result || 'PENDING',
    });
    if (completed?.result && ['CONFIRMED', 'REJECTED', 'PARTIAL'].includes(completed.result)) {
      await createFarmMemory({
        fieldId: row.field_id,
        event: `Verification completed for ${row.entity_type} ${row.entity_id}`,
        evidenceIds: completed.evidence_ids || [],
        reasoning: 'Outcome observed and verified against expected outcome.',
        action: row.entity_type,
        expectedOutcome: completed.expected_outcome || {},
        actualOutcome: completed.actual_outcome || {},
        verificationResult: completed.result,
        learnedRule: completed.result === 'CONFIRMED' ? 'Expected outcome confirmed by field evidence.' : undefined,
      });
    }
    await emitEvent('VERIFICATION_COMPLETED', { verification_id: row.id, result: completed?.result }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    res.json({ success: true, data: completed });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

async function listVerificationsForUser(userId: string) {
  const { dbAll } = await import('../data/db');
  return dbAll(`SELECT v.* FROM verifications v JOIN fields f ON f.id = v.field_id WHERE f.user_id = $1`, [userId]);
}

export default router;
