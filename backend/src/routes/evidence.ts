import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { listEvidence, getEvidence, insertEvidence, listRelationships, evidenceSummary } from '../data/evidence';
import { listContradictions } from '../data/intel';
import { getFieldFarm } from '../data/fields';
import { emitEvent } from '../services/events';
import type { EvidenceState } from '@agrifur2/shared';

const router = Router({ mergeParams: true });
const VALID_SOURCES = ['PHYSICAL_HARDWARE', 'EARTH_OBSERVATION', 'WATER', 'ENVIRONMENT', 'TERRAIN', 'AGRICULTURE', 'HISTORY', 'FARMER_INPUT', 'SIMULATION_VIRTUAL'];
const VALID_STATES: EvidenceState[] = ['OBSERVED', 'DERIVED', 'ESTIMATED', 'HISTORICAL', 'REANALYSIS', 'MODEL_DERIVED', 'PREDICTED', 'SIMULATED', 'MODELLED', 'UNKNOWN'];

router.get('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const { source } = req.query;
  const rows = await listEvidence({
    fieldId: req.fieldContext!.fieldId,
    userId: req.user!.id,
    source: typeof source === 'string' ? source : undefined,
  });
  res.json({ success: true, data: rows, total: rows.length });
});

router.post('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { source, provider, observation_time, measurement, unit, state, quality, provenance, geometry, depth_meters } = req.body || {};
    if (!source || !VALID_SOURCES.includes(source)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: `source must be one of ${VALID_SOURCES.join(', ')}` } });
    }
    if (!measurement || typeof measurement !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'measurement object is required' } });
    }
    const field = await getFieldFarm(req.fieldContext!.fieldId);
    if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    const row = await insertEvidence({
      userId: req.user!.id, farmId: field.farm_id, fieldId: req.fieldContext!.fieldId,
      source, provider: provider || undefined,
      observationTime: observation_time ? new Date(observation_time).toISOString() : new Date().toISOString(),
      measurement,
      unit: unit || undefined,
      state: VALID_STATES.includes(state) ? state : 'UNKNOWN',
      quality: quality || null,
      provenance: provenance || {},
      geometry: geometry || null,
      depthMeters: depth_meters != null ? Number(depth_meters) : null,
    });
    await emitEvent('EVIDENCE_ADDED', { evidence_id: row.id, source: row.source, state: row.state }, { fieldId: row.field_id, userId: req.user!.id }).catch(() => {});
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/lineage', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listEvidence({ fieldId: req.fieldContext!.fieldId, userId: req.user!.id, limit: 500 });
  const relationships = await listRelationships(req.fieldContext!.fieldId);
  const lineage = rows.map((r) => ({
    id: r.id, source: r.source, provider: r.provider, state: r.state,
    observation_time: r.observation_time, retrieved_at: r.retrieved_at,
    provenance: r.provenance,
    derived_from: relationships.filter((x) => x.target_evidence_id === r.id && x.relationship === 'DERIVED_FROM').map((x) => x.source_evidence_id),
    supports: relationships.filter((x) => x.source_evidence_id === r.id && x.relationship === 'SUPPORTS').map((x) => x.target_evidence_id),
    contradicts: relationships.filter((x) => x.source_evidence_id === r.id && x.relationship === 'CONTRADICTS').map((x) => x.target_evidence_id),
  }));
  res.json({ success: true, data: lineage });
});

router.get('/quality', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listEvidence({ fieldId: req.fieldContext!.fieldId, userId: req.user!.id, limit: 500 });
  const assessed = rows.filter((r) => r.quality);
  const summary = await evidenceSummary(req.fieldContext!.fieldId);
  res.json({
    success: true,
    data: {
      total_evidence: summary.total,
      assessed_records: assessed.length,
      not_assessed_records: rows.length - assessed.length,
      quality_label: assessed.length > 0 ? 'PARTIALLY_ASSESSED' : 'NOT_ASSESSED',
      note: 'Aggregate quality scoring requires a calibrated quality model. Per-record quality is stored with each evidence item when computed.',
      evidence_by_source: summary.by_source,
      evidence_by_state: summary.by_state,
    },
  });
});

router.get('/contradictions', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const contradictions = await listContradictions(req.fieldContext!.fieldId, true);
  res.json({ success: true, data: contradictions });
});

router.get('/:evidenceId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const row = await getEvidence(req.params.evidenceId, req.user!.id);
  if (!row || row.field_id !== req.fieldContext!.fieldId) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Evidence not found' } });
  }
  res.json({ success: true, data: row });
});

export default router;
