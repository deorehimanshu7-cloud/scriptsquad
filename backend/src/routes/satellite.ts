import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { getField } from '../data/fields';
import { listSatelliteProducts, getEvidence, listEvidence } from '../data/evidence';
import { searchAndStoreSatellite } from '../services/providers/services';
import { CopernicusAdapter } from '../services/providers/adapters/copernicus';

const router = Router({ mergeParams: true });

async function requireField(req: FieldIsolatedRequest, res: Response) {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) {
    res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    return null;
  }
  return field;
}

router.get('/latest', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await requireField(req, res);
    if (!field) return;
    const outcome = await searchAndStoreSatellite(field, req.user!.id, { providers: ['copernicus', 'landsat'], days: 60 });
    const latest = (outcome.products || []).slice(0, 1)[0] || null;
    res.json({
      success: true,
      data: latest,
      products_count: outcome.stored,
      state: outcome.status === 'AVAILABLE' ? 'OBSERVED' : outcome.status,
      provider: outcome.provider,
      message: outcome.message,
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/search', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const field = await requireField(req, res);
    if (!field) return;
    const { datetime, collections, maxCloudCover, providers } = req.body || {};
    // If explicit datetime/collections given → adapter-level search (not stored)
    if (datetime || collections) {
      const adapter = new CopernicusAdapter();
      const coords = ((field.geometry as GeoJSON.Polygon).coordinates?.[0] || []);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const c of coords) { minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]); maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]); }
      const bbox = [minX, minY, maxX, maxY];
      const result = await adapter.searchProducts({
        bbox,
        datetime: typeof datetime === 'string' ? datetime : `${new Date(Date.now() - 60 * 86400000).toISOString()}/${new Date().toISOString()}`,
        collections: Array.isArray(collections) ? collections : ['sentinel-2-l2a'],
        maxCloudCover: typeof maxCloudCover === 'number' ? maxCloudCover : 30,
      });
      return res.json({
        success: true,
        data: result.data || [],
        state: result.status === 'AVAILABLE' ? 'OBSERVED' : result.status,
        provider: result.provider,
        message: result.error,
      });
    }
    // default: search + persist latest products (canonical EO evidence)
    const outcome = await searchAndStoreSatellite(field, req.user!.id, {
      providers: providers === 'landsat' ? ['landsat'] : ['copernicus', 'landsat'],
      days: 60, maxCloud: typeof maxCloudCover === 'number' ? maxCloudCover : 30,
    });
    const products = await listSatelliteProducts(field.id, 50);
    res.json({ success: true, data: products, state: outcome.status, provider: outcome.provider, message: outcome.message, stored: outcome.stored });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/products', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listSatelliteProducts(req.fieldContext!.fieldId, 50);
  res.json({ success: true, data: products, total: products.length });
});

router.get('/products/:productId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listSatelliteProducts(req.fieldContext!.fieldId, 200);
  const product = products.find((p) => p.id === req.params.productId || p.product_id === req.params.productId);
  if (!product) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Satellite product not found' } });
  // provenance: find the evidence record carrying this product
  const evidence = await listEvidence({ fieldId: req.fieldContext!.fieldId, userId: req.user!.id, limit: 500 });
  const ev = evidence.find((e) => (e.measurement as any)?.product_id === product.product_id) || null;
  res.json({ success: true, data: { ...product, evidence: ev } });
});

router.post('/process', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  // Index derivation requires downloading actual band assets. Without an
  // authenticated asset pipeline, processing cannot fabricate indices.
  const { product_id, algorithm } = req.body || {};
  res.json({
    success: true,
    data: null,
    state: product_id ? 'AUTH_REQUIRED' : 'NO_DATA',
    message: 'Band-level index processing (e.g. NDVI/NDMI) downloads actual COG assets from the provider. Asset download requires provider authentication; no synthetic index is produced.',
    requested: { product_id, algorithm: algorithm || 'NDVI' },
  });
});

router.get('/indices', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listSatelliteProducts(req.fieldContext!.fieldId, 50);
  const indices = await getStoredIndices(req.fieldContext!.fieldId, req.user!.id);
  res.json({
    success: true,
    data: indices,
    state: indices.length > 0 ? 'DERIVED' : products.length > 0 ? 'NO_DATA' : 'NO_DATA',
    message: indices.length === 0 ? 'No derived spectral indices stored. Index derivation requires real band processing of an acquired product.' : undefined,
  });
});

async function getStoredIndices(fieldId: string, userId: string) {
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  return evidence
    .filter((e) => e.source === 'EARTH_OBSERVATION' && e.state === 'DERIVED' && (e.measurement as any)?.index)
    .map((e) => ({ ...(e.measurement as any), evidence_id: e.id, provenance: e.provenance, observation_time: e.observation_time }));
}

router.get('/timeseries', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listSatelliteProducts(req.fieldContext!.fieldId, 200);
  const series = products.map((p) => ({
    product_id: p.product_id, collection: p.collection, observation_date: p.observation_date,
    cloud_cover: p.cloud_cover, provider: p.provider_id,
  }));
  res.json({ success: true, data: series, total: series.length });
});

router.get('/changes', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  // Real change detection requires ≥2 processed acquisitions of the same AOI.
  const products = await listSatelliteProducts(req.fieldContext!.fieldId, 200);
  res.json({
    success: true,
    data: [],
    state: products.length >= 2 ? 'NO_DATA' : 'NO_DATA',
    message: products.length >= 2
      ? 'Two acquisitions exist but change detection requires processed band products (see /satellite/process).'
      : 'Change detection needs at least two acquisitions of the same area.',
  });
});

export default router;
