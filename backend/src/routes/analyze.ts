/**
 * Analysis & intelligence routes.
 *   POST /api/fields/:fieldId/analyze        — run full pipeline
 *   GET  /api/fields/:fieldId/intelligence   — current intelligence state
 *   GET  /api/fields/:fieldId/anomalies      — stored anomalies
 *   GET  /api/fields/:fieldId/risks          — stored risks
 *   GET  /api/fields/:fieldId/uncertainty    — stored uncertainty assessment
 *   GET  /api/fields/:fieldId/contradictions — stored contradictions
 *   GET  /api/fields/:fieldId/next-observations — next-best observations
 */
import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { runFieldPipeline } from '../services/intelligence/pipeline';
import { getField } from '../data/fields';
import { listAnomalies, listRisks, latestUncertainty, listContradictions } from '../data/intel';
import { suggestNextObservations } from '../services/intelligence/next-best-observation';

const router = Router();

router.post('/:fieldId/analyze', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const body = req.body || {};
    const results = await runFieldPipeline(req.fieldContext!.fieldId, req.user!.id, {
      fetchWeather: body.fetch_weather !== false,
      fetchSatellite: body.fetch_satellite !== false,
      fetchSoil: !!body.fetch_soil,
      fetchTerrain: !!body.fetch_terrain,
    });
    res.json({ success: true, data: results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:fieldId/intelligence', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  const [anomalies, risks, uncertainty, contradictions, nextObs] = await Promise.all([
    listAnomalies(field.id, 100),
    listRisks(field.id, true, 100),
    latestUncertainty(field.id),
    listContradictions(field.id, true, 100),
    suggestNextObservations(field.id),
  ]);
  res.json({
    success: true,
    data: {
      field_id: field.id,
      anomalies,
      risks,
      uncertainty: uncertainty?.assessment || null,
      contradictions,
      next_observations: nextObs,
      analysis_state: anomalies.length || risks.length ? 'ANALYZED' : 'NOT_ANALYZED',
    },
  });
});

router.get('/:fieldId/anomalies', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const anomalies = await listAnomalies(req.fieldContext!.fieldId, 200);
  res.json({ success: true, data: anomalies, total: anomalies.length });
});

router.get('/:fieldId/risks', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const risks = await listRisks(req.fieldContext!.fieldId, false, 200);
  res.json({ success: true, data: risks, total: risks.length });
});

router.get('/:fieldId/uncertainty', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const u = await latestUncertainty(req.fieldContext!.fieldId);
  res.json({ success: true, data: u?.assessment || null });
});

router.get('/:fieldId/contradictions', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const contradictions = await listContradictions(req.fieldContext!.fieldId, false, 200);
  res.json({ success: true, data: contradictions, total: contradictions.length });
});

router.get('/:fieldId/next-observations', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const nextObs = await suggestNextObservations(req.fieldContext!.fieldId);
  res.json({ success: true, data: nextObs, note: 'Ranking is qualitative (HIGH/MEDIUM/LOW). Numerical information gain is not implemented.' });
});

export default router;
