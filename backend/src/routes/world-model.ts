import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { getField } from '../data/fields';
import { buildWorldModel } from '../services/intelligence/world-model-builder';
import { latestWorldModelSnapshot, listWorldModelSnapshots } from '../data/system';
import { listInvestigations, listRisks } from '../data/intel';

const router = Router({ mergeParams: true });

router.get('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await getField(req.fieldContext!.fieldId, req.user!.id);
    if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    const worldModel = await buildWorldModel(field, req.user!.id);
    res.json({ success: true, data: worldModel });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/current', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const snapshot = await latestWorldModelSnapshot(req.fieldContext!.fieldId);
  if (!snapshot) {
    const field = await getField(req.fieldContext!.fieldId, req.user!.id);
    if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    const wm = await buildWorldModel(field, req.user!.id);
    return res.json({ success: true, data: wm });
  }
  res.json({ success: true, data: snapshot.world_model });
});

router.get('/history', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const history = await listWorldModelSnapshots(req.fieldContext!.fieldId);
  res.json({ success: true, data: history });
});

router.get('/zones', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  // Zone-level state requires sub-field analytics; none are computed without
  // genuine zonal evidence — return UNKNOWN truthfully.
  res.json({ success: true, data: [], state: 'NO_DATA', note: 'Zonal world-model analysis requires intra-field evidence (e.g. sub-field imagery/zone sensors). Not computed.' });
});

router.get('/diff', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const snapshots = await listWorldModelSnapshots(req.fieldContext!.fieldId);
  const list = snapshots.reverse();
  if (list.length < 2) {
    return res.json({ success: true, data: { changes: [], message: 'At least two world-model snapshots are required for a diff' } });
  }
  const [older, newer] = [list[0], list[1]];
  const a = older.world_model;
  const b = newer.world_model;
  const changes: any[] = [];
  const domains = ['weather', 'satellite', 'sensors', 'soil', 'water', 'terrain', 'crop'];
  for (const d of domains) {
    const sa = a?.state?.[d]?.state || 'UNKNOWN';
    const sb = b?.state?.[d]?.state || 'UNKNOWN';
    if (sa !== sb) changes.push({ domain: d, from: sa, to: sb });
  }
  const countDelta = (b?.coverage?.total_evidence || 0) - (a?.coverage?.total_evidence || 0);
  changes.push({ domain: 'evidence', from: a?.coverage?.total_evidence || 0, to: b?.coverage?.total_evidence || 0, delta: countDelta });
  res.json({ success: true, data: { older_version: older.version, newer_version: newer.version, changes } });
});

router.get('/intelligence', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  const wm = await buildWorldModel(field, req.user!.id);
  const investigations = await listInvestigations(req.fieldContext!.fieldId, req.user!.id);
  const risks = await listRisks(req.fieldContext!.fieldId, true);
  res.json({
    success: true,
    data: {
      field_id: field.id,
      what_changed: wm.evidence_gaps,
      risks,
      anomalies: wm.anomalies,
      contradictions: wm.contradictions,
      uncertainty: {
        coverage: wm.coverage,
        explanation: wm.evidence_gaps,
        data_quality: 'NOT_ASSESSED',
      },
      investigations: investigations.map((i) => ({ id: i.id, title: i.title, status: i.status, updated_at: i.updated_at })),
    },
  });
});

export default router;
