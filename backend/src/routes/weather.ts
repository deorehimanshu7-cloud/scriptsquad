import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { getField } from '../data/fields';
import { fetchAndStoreWeather } from '../services/providers/services';
import { latestWeatherObservation } from '../data/evidence';

const router = Router({ mergeParams: true });

async function requireField(req: FieldIsolatedRequest, res: Response) {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    return null;
  }
  return field;
}

function stateOf(status: string): string {
  switch (status) {
    case 'AVAILABLE': return 'MODEL_DERIVED';
    case 'NO_DATA': return 'NO_DATA';
    case 'RATE_LIMITED': return 'RATE_LIMITED';
    case 'TIMEOUT': return 'TIMEOUT';
    case 'AUTH_REQUIRED': return 'AUTH_REQUIRED';
    default: return 'UNAVAILABLE';
  }
}

router.get('/current', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await requireField(req, res);
    if (!field) return;
    const cached = await latestWeatherObservation(field.id, 'current');
    if (cached && Date.now() - new Date(cached.retrieved_at).getTime() < 15 * 60 * 1000) {
      return res.json({ success: true, data: { current: cached.data }, semantics: cached.semantics, provider: cached.provider, source: 'cache', retrieved_at: cached.retrieved_at, state: cached.semantics });
    }
    const result = await fetchAndStoreWeather(field, req.user!.id, 'current');
    res.json({
      success: true,
      data: result.data?.current || null,
      forecast: result.data?.daily || [],
      state: stateOf(result.status),
      semantics: 'MODEL_DERIVED',
      provider: result.provider,
      message: result.error || result.message,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/forecast', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await requireField(req, res);
    if (!field) return;
    const cached = await latestWeatherObservation(field.id, 'forecast');
    if (cached && Date.now() - new Date(cached.retrieved_at).getTime() < 60 * 60 * 1000) {
      return res.json({ success: true, data: cached.data, semantics: cached.semantics, provider: cached.provider, state: 'PREDICTED' });
    }
    const result = await fetchAndStoreWeather(field, req.user!.id, 'current');
    res.json({
      success: true,
      data: result.data?.daily || [],
      semantics: 'PREDICTED',
      state: result.status === 'AVAILABLE' ? 'PREDICTED' : stateOf(result.status),
      provider: result.provider,
      message: result.error || result.message,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/history', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await requireField(req, res);
    if (!field) return;
    const result = await fetchAndStoreWeather(field, req.user!.id, 'history');
    res.json({
      success: true,
      data: result.data?.daily || [],
      semantics: 'REANALYSIS',
      note: 'Historical weather is ERA5/ERA5-Land reanalysis through Open-Meteo Archive — reanalysis/model data, not physical observations.',
      state: result.status === 'AVAILABLE' ? 'REANALYSIS' : stateOf(result.status),
      provider: result.provider,
      message: result.error || result.message,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/anomalies', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listWeatherObservationsKind(req.fieldContext!.fieldId, 'anomaly');
  res.json({ success: true, data: rows, note: 'Weather anomaly analysis is derived from stored history when enough records exist.' });
});

async function listWeatherObservationsKind(fieldId: string, kind: string) {
  const { listWeatherObservations } = await import('../data/evidence');
  return listWeatherObservations(fieldId, kind);
}

export default router;
