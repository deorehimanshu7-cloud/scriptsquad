/**
 * Soil / Terrain / Water / Crop routes.
 *  - Soil: SoilGrids v2 modelled estimates (ESTIMATED + uncertainty), real.
 *  - Terrain: DEM elevation sample (Open-Meteo elevation), DERIVED.
 *  - Water: no credential-free verified national dataset is integrated;
 *    groundwater/surface/irrigation endpoints report truthful NO_DATA with
 *    provenance of the intended provider (CGWB / India-WRIS require auth).
 *  - Crop: cycles CRUD; state UNKNOWN until observed.
 */
import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { getField } from '../data/fields';
import { listSoilObservations, listWaterObservations, listTerrainProducts } from '../data/evidence';
import { fetchAndStoreSoil, fetchAndStoreTerrain } from '../services/providers/services';
import { createCropCycle, listCropCycles, recordCropState, listCropStates, latestCropCycle } from '../data/crops';
import { emitEvent } from '../services/events';

const router = Router({ mergeParams: true });

async function requireField(req: FieldIsolatedRequest, res: Response) {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) { res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } }); return null; }
  return field;
}

// ── Soil ────────────────────────────────────────────────────────────────────
router.get('/:fieldId/soil', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listSoilObservations(req.fieldContext!.fieldId);
  const properties = rows.map((r) => ({
    property: r.property, value: r.value, unit: r.unit, state: r.state,
    source: r.source, timestamp: r.timestamp, quality: r.quality,
    uncertainty: r.uncertainty, provenance: r.provenance,
    depth: (r.provenance as any)?.depth ?? null,
  }));
  res.json({
    success: true,
    data: {
      field_id: req.fieldContext!.fieldId,
      properties,
      state: properties.length ? 'AVAILABLE' : 'NO_DATA',
      note: properties.length === 0 ? 'No soil observations stored. Fetch modelled estimates from SoilGrids (values are ESTIMATED with model uncertainty — never OBSERVED).' : undefined,
    },
  });
});

router.post('/:fieldId/soil/fetch', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await requireField(req, res);
  if (!field) return;
  const result = await fetchAndStoreSoil(field, req.user!.id);
  const rows = await listSoilObservations(field.id);
  res.json({ success: true, data: rows, provider_status: result.status, message: result.message || result.error });
});

router.get('/:fieldId/soil/profile', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listSoilObservations(req.fieldContext!.fieldId);
  res.json({ success: true, data: rows, state: rows.length ? 'AVAILABLE' : 'NO_DATA' });
});

router.get('/:fieldId/soil/root-zone', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listSoilObservations(req.fieldContext!.fieldId);
  const depth = (r: any) => (r.provenance as any)?.depth as string | undefined;
  const rootZone = rows.filter((r) => depth(r)?.endsWith('30cm') || depth(r)?.endsWith('15cm'));
  res.json({ success: true, data: rootZone, state: rootZone.length ? 'AVAILABLE' : 'NO_DATA' });
});

// ── Terrain ─────────────────────────────────────────────────────────────────
router.get('/:fieldId/terrain', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listTerrainProducts(req.fieldContext!.fieldId);
  const elevation = products.find((p) => p.kind === 'elevation');
  res.json({
    success: true,
    data: {
      field_id: req.fieldContext!.fieldId,
      state: elevation ? elevation.state : 'NO_DATA',
      elevation_m: elevation?.data?.elevation_m ?? null,
      source: elevation?.provider || null,
      products,
      note: elevation ? 'Elevation is DERIVED from a DEM sample — not an on-site survey.' : 'Terrain data unavailable: fetch DEM elevation for this field.',
    },
  });
});

router.post('/:fieldId/terrain/fetch', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await requireField(req, res);
  if (!field) return;
  const result = await fetchAndStoreTerrain(field, req.user!.id);
  res.json({ success: true, data: result.data, provider_status: result.status, message: result.message || result.error });
});

router.get('/:fieldId/terrain/elevation', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listTerrainProducts(req.fieldContext!.fieldId);
  const elevation = products.find((p) => p.kind === 'elevation');
  res.json({ success: true, data: elevation || null, state: elevation ? elevation.state : 'NO_DATA' });
});

// ── Water (truthful NO_DATA until a verified credential-free source exists) ─
router.get('/:fieldId/water', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listWaterObservations(req.fieldContext!.fieldId);
  res.json({
    success: true,
    data: { field_id: req.fieldContext!.fieldId, observations: rows, domains: {} },
    state: rows.length ? 'AVAILABLE' : 'NO_DATA',
    message: rows.length === 0
      ? 'NO_DATA: national water datasets (CGWB groundwater, India-WRIS) require credentials or are not yet integrated with a verified public endpoint. Groundwater depth is never fabricated.'
      : undefined,
  });
});

router.get('/:fieldId/water/surface', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = (await listWaterObservations(req.fieldContext!.fieldId)).filter((w) => w.domain === 'surface');
  res.json({ success: true, data: rows, state: rows.length ? 'AVAILABLE' : 'NO_DATA', message: rows.length ? undefined : 'NO_DATA: no surface-water observations.' });
});

router.get('/:fieldId/water/groundwater', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = (await listWaterObservations(req.fieldContext!.fieldId)).filter((w) => w.domain === 'groundwater');
  res.json({ success: true, data: rows, state: rows.length ? 'AVAILABLE' : 'NO_DATA', message: rows.length ? undefined : 'NO_DATA: groundwater depth is never fabricated — a CGWB/India-WRIS credential-gated adapter is required.' });
});

router.get('/:fieldId/water/irrigation', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = (await listWaterObservations(req.fieldContext!.fieldId)).filter((w) => w.domain === 'irrigation');
  res.json({ success: true, data: rows, state: rows.length ? 'AVAILABLE' : 'NO_DATA', message: rows.length ? undefined : 'NO_DATA: irrigation records must be registered by the farmer or an irrigation controller.' });
});

// ── Crop ────────────────────────────────────────────────────────────────────
router.get('/:fieldId/crop', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const cycles = await listCropCycles(req.fieldContext!.fieldId);
  const latest = await latestCropCycle(req.fieldContext!.fieldId);
  const states = latest ? await listCropStates(latest.id) : [];
  res.json({ success: true, data: { cycles, latest, states }, state: latest ? 'OBSERVED' : 'UNKNOWN' });
});

router.post('/:fieldId/crop', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { crop_type, variety, season, sowing_date, expected_harvest_date } = req.body || {};
    if (!crop_type) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'crop_type is required' } });
    const cycle = await createCropCycle({
      fieldId: req.fieldContext!.fieldId, cropType: crop_type, variety, season,
      sowingDate: sowing_date, expectedHarvestDate: expected_harvest_date,
    });
    await emitEvent('FIELD_UPDATED', { crop_cycle: cycle.id, crop_type }, { fieldId: req.fieldContext!.fieldId, userId: req.user!.id }).catch(() => {});
    res.status(201).json({ success: true, data: cycle });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/:fieldId/crop/state', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const { growth_stage, health_index, observations, state } = req.body || {};
  const latest = await latestCropCycle(req.fieldContext!.fieldId);
  if (!latest) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Create a crop cycle first' } });
  const row = await recordCropState({
    cycleId: latest.id, growthStage: growth_stage, healthIndex: health_index != null ? Number(health_index) : undefined,
    observations: observations || {}, state: state || 'UNKNOWN',
  });
  res.status(201).json({ success: true, data: row });
});

export default router;
