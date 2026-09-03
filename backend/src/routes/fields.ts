import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import {
  listFields, getField, createField, updateFieldGeometry, updateFieldMeta, deleteField,
  validateFieldGeometry, listGeometryVersions, getFieldFarm,
} from '../data/fields';
import { countEvidence } from '../data/evidence';
import { audit } from '../data/system';
import { emitEvent } from '../services/events';
import { closeRing, type Ring } from '@agrifur2/shared';

function toRing(positions: number[][]): Ring {
  return positions.map((c) => [c[0], c[1]] as [number, number]);
}

const router = Router();

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const fields = await listFields(req.user!.id);
  res.json({ success: true, data: fields, total: fields.length });
});

function parsePolygonFromBody(body: any): GeoJSON.Polygon | null {
  let geometry = body?.geometry;
  if (body?.geojson) {
    const gj = body.geojson;
    if (gj.type === 'Feature') geometry = gj.geometry;
    else if (gj.type === 'FeatureCollection') geometry = gj.features?.find((f: any) => f.geometry?.type === 'Polygon')?.geometry;
    else geometry = gj;
  }
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates)) return null;
  return geometry as GeoJSON.Polygon;
}

async function respondValidation(geometry: GeoJSON.Polygon, res: Response): Promise<boolean> {
  const issues = validateFieldGeometry(geometry);
  if (issues.length > 0) {
    res.status(400).json({ success: false, error: { code: 'GEOMETRY_INVALID', message: 'Invalid field geometry', issues } });
    return false;
  }
  return true;
}

async function createFieldFromGeometry(req: AuthRequest, res: Response, name: string, farmId: string, geometry: GeoJSON.Polygon) {
  const closed = closeRing(toRing(geometry.coordinates[0] as unknown as number[][]));
  const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: [closed as unknown as number[][]] };
  if (!(await respondValidation(poly, res))) return;
  if (!farmId) {
    res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'farm_id is required' } });
    return;
  }
  const field = await createField({ userId: req.user!.id, farmId, name, geometry: poly });
  await audit({ userId: req.user!.id, action: 'FIELD_CREATED', entityType: 'field', entityId: field.id, requestId: (req.headers['x-request-id'] as string) || undefined });
  await emitEvent('FIELD_CREATED', { field_id: field.id, farm_id: farmId, area_hectares: field.area_hectares }, { fieldId: field.id, userId: req.user!.id }).catch(() => {});
  res.status(201).json({ success: true, data: field, meta: { metrics_computed_by: field.metrics_computed_by } });
}

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, farm_id } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'name is required' } });
    const geometry = parsePolygonFromBody(req.body);
    if (!geometry) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'geometry must be a GeoJSON Polygon' } });
    await createFieldFromGeometry(req, res, name, farm_id, geometry);
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/import-geojson', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, farm_id } = req.body || {};
    const geometry = parsePolygonFromBody(req.body);
    if (!geometry) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Provide a GeoJSON Polygon (Feature/FeatureCollection accepted)' } });
    await createFieldFromGeometry(req, res, name || 'Imported field', farm_id, geometry);
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.post('/from-coordinates', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, farm_id, coordinates } = req.body || {};
    let pairs: number[][] = [];
    if (Array.isArray(coordinates)) {
      pairs = coordinates.map((c: any): number[] | null => {
        if (Array.isArray(c)) return c.length === 2 ? [Number(c[0]), Number(c[1])] : null;
        if (typeof c === 'string') {
          const [a, b] = c.split(',').map(Number);
          return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
        }
        return null;
      }).filter((c: number[] | null): c is number[] => c !== null);
    } else if (typeof coordinates === 'string') {
      pairs = coordinates.split(';').map((pair: string) => pair.split(',').map(Number)).filter((c: number[]) => c.length === 2 && c.every(Number.isFinite));
    }
    if (pairs.length < 3) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'At least 3 coordinate pairs are required (lat,lng)' } });
    // input is (lat, lng); GeoJSON ring must be [lng, lat]
    const ring = pairs.map(([lat, lng]) => [lng, lat] as [number, number]);
    const geometry: GeoJSON.Polygon = { type: 'Polygon', coordinates: [closeRing(ring)] };
    await createFieldFromGeometry(req, res, name || 'Coordinate field', farm_id, geometry);
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:fieldId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  res.json({ success: true, data: field, meta: { metrics_computed_by: field.metrics_computed_by } });
});

router.patch('/:fieldId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const { name, status } = req.body || {};
  const updated = await updateFieldMeta({ fieldId: req.fieldContext!.fieldId, userId: req.user!.id, name, status });
  if (!updated) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  await emitEvent('FIELD_UPDATED', { field_id: updated.id }, { fieldId: updated.id, userId: req.user!.id }).catch(() => {});
  res.json({ success: true, data: updated });
});

router.patch('/:fieldId/geometry', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const geometry = parsePolygonFromBody(req.body);
    if (!geometry) return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'geometry must be a GeoJSON Polygon' } });
    const closed: GeoJSON.Polygon = { type: 'Polygon', coordinates: [closeRing(toRing(geometry.coordinates[0] as unknown as number[][])) as unknown as number[][]] };
    if (!(await respondValidation(closed, res))) return;
    const field = await getField(req.fieldContext!.fieldId, req.user!.id);
    if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
    const updated = await updateFieldGeometry({ fieldId: field.id, userId: req.user!.id, farmId: field.farm_id, geometry: closed });
    await emitEvent('FIELD_UPDATED', { field_id: updated?.id, geometry_version: 'bumped' }, { fieldId: field.id, userId: req.user!.id }).catch(() => {});
    res.json({ success: true, data: updated, meta: { metrics_computed_by: updated?.metrics_computed_by } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:fieldId/geometry', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  const versions = await listGeometryVersions(field.id);
  res.json({
    success: true,
    data: {
      field_id: field.id,
      geometry: field.geometry,
      centroid: field.centroid,
      bbox: field.bbox,
      area_m2: field.area_m2,
      area_hectares: field.area_hectares,
      perimeter_m: field.perimeter_m,
      srid: field.srid,
      geometry_valid: field.geometry_valid,
      metrics_computed_by: field.metrics_computed_by,
      versions,
    },
  });
});

router.get('/:fieldId/context', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  res.json({
    success: true,
    data: {
      field_id: field.id, farm_id: field.farm_id, name: field.name, status: field.status,
      geometry: field.geometry, centroid: field.centroid, bbox: field.bbox,
      area_hectares: field.area_hectares, metrics_computed_by: field.metrics_computed_by,
    },
  });
});

router.get('/:fieldId/summary', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  const evidence_count = await countEvidence(field.id);
  res.json({
    success: true,
    data: {
      field_id: field.id, name: field.name,
      area_hectares: field.area_hectares,
      perimeter_m: field.perimeter_m,
      centroid: field.centroid,
      status: field.status,
      evidence_count,
      geometry_valid: field.geometry_valid,
      metrics_computed_by: field.metrics_computed_by,
    },
  });
});

router.delete('/:fieldId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const ok = await deleteField(req.fieldContext!.fieldId, req.user!.id);
  if (!ok) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  await audit({ userId: req.user!.id, action: 'FIELD_DELETED', entityType: 'field', entityId: req.fieldContext!.fieldId, requestId: (req.headers['x-request-id'] as string) || undefined });
  await emitEvent('FIELD_DELETED', { field_id: req.fieldContext!.fieldId }, { userId: req.user!.id }).catch(() => {});
  res.json({ success: true, message: 'Field deleted successfully' });
});

export default router;
