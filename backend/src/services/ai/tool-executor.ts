/**
 * AI Tool Executor — repository-backed. Every tool returns REAL persisted or
 * freshly fetched field data. The LLM (or local engine) can only reason over
 * these results; it can never invent measurements, products or confidence.
 */
import { getField } from '../../data/fields';
import { buildWorldModel } from '../intelligence/world-model-builder';
import { listEvidence, listSatelliteProducts, latestWeatherObservation, listSoilObservations, listWaterObservations, listTerrainProducts } from '../../data/evidence';
import { listAnomalies, listRisks, latestUncertainty, listContradictions, listInvestigations, listFarmMemory, listFarmerObservations } from '../../data/intel';
import { listObservations, listSensorsForField, calibrationStatus, listDevicesForField, deriveDeviceState } from '../../data/sensors';
import { suggestNextObservations } from '../intelligence/next-best-observation';
import { searchAndStoreSatellite } from '../providers/services';

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
}

export async function executeTool(toolName: string, args: Record<string, any>, userId: string): Promise<ToolResult> {
  const fieldId = String(args.fieldId || '');
  try {
    switch (toolName) {
      case 'getField': {
        const field = await getField(fieldId, userId);
        if (!field) return { ok: false, error: 'Field not found or not accessible' };
        return { ok: true, data: { id: field.id, name: field.name, area_hectares: field.area_hectares, centroid: field.centroid, metrics_computed_by: field.metrics_computed_by } };
      }
      case 'getWorldModel': {
        const field = await getField(fieldId, userId);
        if (!field) return { ok: false, error: 'Field not found or not accessible' };
        const wm = await buildWorldModel(field, userId);
        return { ok: true, data: wm };
      }
      case 'getEvidence': {
        const rows = await listEvidence({ fieldId, userId, source: args.source || undefined, limit: 200 });
        return { ok: true, data: rows.map((e) => ({ id: e.id, source: e.source, provider: e.provider, state: e.state, observation_time: e.observation_time, measurement: e.measurement, provenance: e.provenance })) };
      }
      case 'getWeather': {
        const field = await getField(fieldId, userId);
        if (!field) return { ok: false, error: 'Field not found' };
        const current = await latestWeatherObservation(fieldId, 'current');
        const forecast = await latestWeatherObservation(fieldId, 'forecast');
        if (current) return { ok: true, data: { semantics: current.semantics, current: current.data, forecast: forecast?.data || null, note: 'Weather from Open-Meteo is MODEL_DERIVED (forecast model) — not a physical station observation.' } };
        // cold fetch
        const { fetchAndStoreWeather } = await import('../providers/services');
        const res = await fetchAndStoreWeather(field, userId, 'current');
        return { ok: res.status === 'AVAILABLE', data: res.data?.current || null, meta: { provider_status: res.status, error: res.error } };
      }
      case 'getSatellite': {
        const field = await getField(fieldId, userId);
        if (!field) return { ok: false, error: 'Field not found' };
        const products = await listSatelliteProducts(fieldId, 10);
        if (products.length === 0) {
          const res = await searchAndStoreSatellite(field, userId, { providers: ['copernicus', 'landsat'], days: 60 });
          return { ok: res.status === 'AVAILABLE', data: res.products.slice(0, 10), meta: { provider_status: res.status, message: res.message } };
        }
        return { ok: true, data: products.map((p) => ({ product_id: p.product_id, collection: p.collection, observation_date: p.observation_date, cloud_cover: p.cloud_cover, provider: p.provider_id })) };
      }
      case 'getSensors': {
        const obs = await listObservations({ fieldId, userId, limit: 200 });
        const latest = new Map<string, any>();
        for (const o of obs) if (!latest.has(o.sensor_type || '?')) latest.set(o.sensor_type || '?', o);
        return {
          ok: true,
          data: obs.slice(0, 60).map((o) => ({ sensor_type: o.sensor_type, value: o.value, unit: o.unit, quality: o.quality, timestamp: o.timestamp, device_id: o.device_id, calibration_version: o.calibration_version })),
          meta: {
            latest: Array.from(latest.values()).map((o) => ({ sensor_type: o.sensor_type, value: o.value, unit: o.unit, quality: o.quality, timestamp: o.timestamp })),
            freshness_note: 'Each reading is OBSERVED with its actual timestamp — freshness must be judged from that timestamp, never assumed current.',
          },
        };
      }
      case 'getDeviceStatus': {
        const devices = await listDevicesForField(fieldId, userId);
        const withCal = await Promise.all(devices.map(async (d) => {
          const sensors = await listSensorsForField(fieldId, userId);
          const mine = sensors.filter((s) => s.device_id === d.id);
          const cal = await Promise.all(mine.map(async (s) => ({ sensor_id: s.id, sensor_type: s.sensor_type, calibration: await calibrationStatus(s) })));
          return {
            device_id: d.id, name: d.name, type: d.type,
            derived_state: deriveDeviceState(d), battery: d.battery, last_seen_at: d.last_seen_at,
            sensors: cal,
          };
        }));
        return { ok: true, data: withCal, meta: { note: 'derived_state comes from real heartbeats/telemetry, never hardcoded.' } };
      }
      case 'getSensorHistory': {
        const sensorType = args.sensor_type || args.sensorType;
        if (!sensorType) return { ok: false, error: 'sensor_type is required for getSensorHistory' };
        const rows = await listObservations({ fieldId, userId, sensorType, limit: 50 });
        return { ok: true, data: rows.map((o) => ({ sensor_type: o.sensor_type, value: o.value, unit: o.unit, quality: o.quality, timestamp: o.timestamp, device_id: o.device_id, calibration_version: o.calibration_version })) };
      }
      case 'getCalibration': {
        const sensors = await listSensorsForField(fieldId, userId);
        const target = args.sensorId ? sensors.find((s) => s.id === args.sensorId) : sensors.find((s) => s.sensor_type === (args.sensor_type || ''));
        if (!target && args.sensorId) return { ok: false, error: 'Sensor not found in this field' };
        if (!target) {
          const all = await Promise.all(sensors.map(async (s) => ({ sensor_id: s.id, sensor_type: s.sensor_type, ...await calibrationStatus(s) })));
          return { ok: true, data: all, meta: { note: 'CALIBRATED / CALIBRATION_EXPIRED / NOT_CALIBRATED from real records.' } };
        }
        const st = await calibrationStatus(target);
        const { listCalibrations } = await import('../../data/sensors');
        const records = await listCalibrations(target.id);
        return { ok: true, data: { sensor: { id: target.id, sensor_type: target.sensor_type, unit: target.unit }, calibration: st, records: records.slice(0, 10) } };
      }
      case 'getSoil': {
        const rows = await listSoilObservations(fieldId);
        return { ok: true, data: rows.map((r) => ({ property: r.property, value: r.value, unit: r.unit, state: r.state, source: r.source, uncertainty: r.uncertainty })) };
      }
      case 'getWater': {
        const rows = await listWaterObservations(fieldId);
        return { ok: true, data: rows, meta: { note: 'Water data is reported only from real observations; groundwater is never fabricated.' } };
      }
      case 'getTerrain': {
        const rows = await listTerrainProducts(fieldId);
        return { ok: true, data: rows };
      }
      case 'getAnomalies': {
        const rows = await listAnomalies(fieldId, 50);
        return { ok: true, data: rows.map((a) => ({ type: a.type, subtype: a.subtype, severity: a.severity, description: a.description, evidence_ids: a.evidence_ids, timestamp: a.timestamp })) };
      }
      case 'getRisks': {
        const rows = await listRisks(fieldId, true, 50);
        return { ok: true, data: rows.map((r) => ({ type: r.type, severity: r.severity, description: r.description, status: r.status })) };
      }
      case 'getUncertainty': {
        const u = await latestUncertainty(fieldId);
        return { ok: true, data: u?.assessment || { coverage: {}, explanation: [], note: 'NOT_ASSESSED' } };
      }
      case 'getContradictions': {
        const rows = await listContradictions(fieldId, true, 50);
        return { ok: true, data: rows };
      }
      case 'getInvestigations': {
        const rows = await listInvestigations(fieldId, userId);
        return { ok: true, data: rows.map((i) => ({ id: i.id, title: i.title, status: i.status, hypothesis_count: (i.hypotheses || []).length })) };
      }
      case 'getHistory': {
        const events = await (await import('../../data/system')).listEvents({ fieldId, limit: 100 });
        return { ok: true, data: events };
      }
      case 'getFarmMemory': {
        const rows = await listFarmMemory(fieldId);
        return { ok: true, data: rows };
      }
      case 'getFarmerObservations': {
        const rows = await listFarmerObservations(fieldId);
        return { ok: true, data: rows };
      }
      case 'suggestNextObservation': {
        const nextObs = await suggestNextObservations(fieldId);
        return { ok: true, data: nextObs };
      }
      case 'createInvestigation': {
        // executed by the assistant service with user context; route to repo
        const { createInvestigation: createInv } = await import('../../data/intel');
        const row = await createInv({
          fieldId, userId, title: args.title || 'AI-initiated investigation',
          question: args.description || args.title || '', triggerType: 'AI_DETECTED',
        });
        return { ok: true, data: { id: row.id, title: row.title, status: row.status } };
      }
      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
