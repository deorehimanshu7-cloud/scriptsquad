/**
 * Digital Twin data API — everything rendered in the 3D scene is real backend
 * state (field geometry from the canonical store; devices at their real
 * coordinates; risks/anomalies/investigations with their evidence). Empty
 * layers are rendered empty — never decorated with fake markers.
 */
import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import { getField } from '../data/fields';
import { listDevicesForField, latestObservationsByType } from '../data/sensors';
import { listAnomalies, listRisks, listContradictions, listInvestigations } from '../data/intel';
import { listFarmerObservations } from '../data/intel';
import { listTerrainProducts, listSoilObservations, listWaterObservations } from '../data/evidence';
import { latestWorldModelSnapshot } from '../data/system';
import { latestCropCycle } from '../data/crops';

const router = Router({ mergeParams: true });

router.get('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const field = await getField(req.fieldContext!.fieldId, req.user!.id);
  if (!field) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Field not found' } });
  const layers = await buildLayers(req);
  res.json({
    success: true,
    data: {
      field_id: field.id,
      geometry: field.geometry,
      centroid: field.centroid,
      metrics: { area_hectares: field.area_hectares, perimeter_m: field.perimeter_m, metrics_computed_by: field.metrics_computed_by },
      layers,
      label: { note: '3D representation is a MODELLED visualization. Crop/roots are MODELLED unless real 3D observations exist; elevation comes from real DEM when available.' },
    },
  });
});

router.get('/layers', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const layers = await buildLayers(req);
  res.json({ success: true, data: layers });
});

router.get('/terrain', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const products = await listTerrainProducts(req.fieldContext!.fieldId);
  res.json({ success: true, data: products, state: products.length ? 'AVAILABLE' : 'NO_DATA' });
});

async function buildLayers(req: FieldIsolatedRequest) {
  const fieldId = req.fieldContext!.fieldId;
  const [devices, readings, anomalies, risks, contradictions, investigations, farmerObs, terrain, soil, water, snapshot, cycle] = await Promise.all([
    listDevicesForField(fieldId, req.user!.id),
    latestObservationsByType(fieldId, 30),
    listAnomalies(fieldId, 100),
    listRisks(fieldId, true, 100),
    listContradictions(fieldId, true, 100),
    listInvestigations(fieldId, req.user!.id),
    listFarmerObservations(fieldId),
    listTerrainProducts(fieldId),
    listSoilObservations(fieldId),
    listWaterObservations(fieldId),
    latestWorldModelSnapshot(fieldId),
    latestCropCycle(fieldId),
  ]);
  return {
    terrain: {
      state: terrain.length ? 'AVAILABLE' : 'NO_DATA',
      products: terrain.map((t) => ({ kind: t.kind, state: t.state, data: t.data, provider: t.provider })),
      note: terrain.length ? 'Elevation sampled from a real DEM (DERIVED).' : 'Terrain data unavailable — render a flat MODELLED surface at the canonical elevation unless DEM fetch succeeds.',
    },
    field: { state: 'OBSERVED', geometry_label: 'canonical PostGIS geometry' },
    crop: {
      state: cycle ? 'OBSERVED' : 'UNKNOWN',
      label: 'MODELLED',
      cycle: cycle || null,
      note: 'Crop canopy and roots are MODELLED representations — they are labelled MODELLED, not observed reality.',
    },
    sensors: {
      state: devices.length ? 'AVAILABLE' : 'NO_DATA',
      devices: devices.map((d) => ({
        id: d.id, name: d.name, type: d.type, status: d.status,
        location: d.location || null, battery: d.battery ?? null, last_seen_at: d.last_seen_at,
        latest: readings.find((r) => r.device_id === d.id) || null,
      })),
    },
    soil: {
      state: soil.length ? 'AVAILABLE' : 'NO_DATA',
      properties: soil.map((s) => ({ property: s.property, value: s.value, unit: s.unit, state: s.state, depth_hint: (s.provenance as any)?.depth || null })),
      note: soil.length ? 'Soil cutaway shows MODELLED soil columns from stored properties.' : 'No soil properties stored — cutaway shows nothing (no fabricated texture).',
    },
    water: { state: water.length ? 'AVAILABLE' : 'NO_DATA', observations: water },
    risk: { state: risks.length ? 'AVAILABLE' : 'NO_DATA', risks: risks.map((r) => ({ id: r.id, type: r.type, severity: r.severity, description: r.description, status: r.status })) },
    anomaly: { state: anomalies.length ? 'AVAILABLE' : 'NO_DATA', anomalies: anomalies.map((a) => ({ id: a.id, type: a.type, subtype: a.subtype, severity: a.severity, description: a.description, timestamp: a.timestamp })) },
    investigation: { state: investigations.length ? 'AVAILABLE' : 'NO_DATA', investigations: investigations.map((i) => ({ id: i.id, title: i.title, status: i.status })) },
    contradiction: { state: contradictions.length ? 'AVAILABLE' : 'NO_DATA', contradictions },
    farmer: { state: farmerObs.length ? 'AVAILABLE' : 'NO_DATA', observations: farmerObs.map((f) => ({ id: f.id, text: f.text, verification: f.verification, location: f.location || null })) },
    world_model_version: snapshot?.version || null,
    world_model_state: (snapshot?.world_model?.coverage?.total_evidence ?? 0) > 0 ? 'BUILT' : 'NOT_BUILT',
  };
}

export default router;
