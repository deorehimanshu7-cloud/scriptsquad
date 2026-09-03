import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { listFarms, createFarm, getFarm, updateFarm, deleteFarm } from '../data/users';
import { countFieldsForFarm } from '../data/fields';
import { audit } from '../data/system';

const router = Router();

router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  const farms = await listFarms(req.user!.id);
  res.json({ success: true, data: farms, total: farms.length });
});

router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { name, location } = req.body || {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'Farm name is required' } });
    }
    let point: GeoJSON.Point | undefined;
    if (location) {
      if (location.type === 'Point' && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
        point = location as GeoJSON.Point;
      } else if (location.type === 'Feature' && location.geometry?.type === 'Point') {
        point = location.geometry;
      } else {
        return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'location must be a GeoJSON Point' } });
      }
    }
    const farm = await createFarm({ userId: req.user!.id, name, location: point });
    await audit({ userId: req.user!.id, action: 'FARM_CREATED', entityType: 'farm', entityId: farm.id, requestId: (req.headers['x-request-id'] as string) || undefined });
    res.status(201).json({ success: true, data: farm });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:farmId', authenticate, async (req: AuthRequest, res: Response) => {
  const farm = await getFarm(req.params.farmId, req.user!.id);
  if (!farm) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Farm not found' } });
  const fields = await countFieldsForFarm(farm.id);
  res.json({ success: true, data: { ...farm, field_count: fields } });
});

router.patch('/:farmId', authenticate, async (req: AuthRequest, res: Response) => {
  const { name, location } = req.body || {};
  const updated = await updateFarm({ farmId: req.params.farmId, userId: req.user!.id, name, location });
  if (!updated) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Farm not found' } });
  res.json({ success: true, data: updated });
});

router.delete('/:farmId', authenticate, async (req: AuthRequest, res: Response) => {
  const ok = await deleteFarm(req.params.farmId, req.user!.id);
  if (!ok) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Farm not found' } });
  await audit({ userId: req.user!.id, action: 'FARM_DELETED', entityType: 'farm', entityId: req.params.farmId, requestId: (req.headers['x-request-id'] as string) || undefined });
  res.json({ success: true, message: 'Farm deleted successfully' });
});

export default router;
