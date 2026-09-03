/**
 * Anomaly Detection Engine (evidence-driven, no fabricated scalars)
 *
 * Every anomaly is derived from real stored evidence:
 *  - threshold checks on real measurements (temperature, wind, cloud cover)
 *  - statistical checks on real sensor series (>3σ)
 *  - cross-source inconsistencies between real evidence items
 * Severity comes from the thresholds; quality is NOT_ASSESSED (null) unless a
 * calibrated quality model exists; uncertainty is never invented.
 */
import { listEvidence } from '../../data/evidence';
import { insertAnomaly, listAnomalies, findAnomalyByKey, type AnomalyRow } from '../../data/intel';
import { generateId } from '../../database/sqlite';

export interface AnomalyAnalysisResult {
  anomalies: AnomalyRow[];
  evidence_count: number;
  sources_analyzed: string[];
  analysis_time: string;
}

export async function analyzeField(fieldId: string, userId: string): Promise<AnomalyAnalysisResult> {
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  const bySource: Record<string, any[]> = {};
  const sources = new Set<string>();
  for (const e of evidence) {
    sources.add(e.source);
    if (!bySource[e.source]) bySource[e.source] = [];
    bySource[e.source].push(e);
  }

  async function add(type: string, subtype: string, description: string, evidenceIds: string[], method: string, severity: 'LOW' | 'MEDIUM' | 'HIGH', geometry?: GeoJSON.Geometry | null) {
    const existing = await findAnomalyByKey(fieldId, type, subtype);
    if (existing) return;
    const anomaly: Omit<AnomalyRow, 'created_at'> = {
      id: generateId(), field_id: fieldId, type, subtype, timestamp: new Date().toISOString(),
      method, evidence_ids: evidenceIds, state: 'DETECTED', severity,
      quality: null, geometry: geometry || null, description,
    };
    await insertAnomaly(anomaly);
  }

  // Weather thresholds (real measurement values)
  const weatherEvidence = bySource['ENVIRONMENT'] || [];
  for (const e of weatherEvidence) {
    const m = e.measurement as any;
    const temp = m?.temperature ?? m?.current?.temperature;
    const wind = m?.wind_speed ?? m?.current?.wind_speed;
    if (typeof temp === 'number' && temp > 42) {
      await add('temperature', 'high_temp', `Temperature ${temp}°C exceeds critical threshold (42°C) — possible heat stress.`, [e.id], 'RANGE_CHECK', 'HIGH', e.geometry || null);
    }
    if (typeof temp === 'number' && temp < 2) {
      await add('temperature', 'frost_risk', `Temperature ${temp}°C indicates frost risk.`, [e.id], 'RANGE_CHECK', 'MEDIUM', e.geometry || null);
    }
    if (typeof wind === 'number' && wind > 50) {
      await add('wind', 'high_wind', `Wind speed ${wind} km/h exceeds safe threshold.`, [e.id], 'RANGE_CHECK', 'MEDIUM', e.geometry || null);
    }
  }

  // Satellite quality checks (real cloud cover from product metadata)
  const satEvidence = bySource['EARTH_OBSERVATION'] || [];
  for (const e of satEvidence) {
    const props = (e.measurement as any)?.properties || {};
    const cloud = props['eo:cloud_cover'];
    if (typeof cloud === 'number' && cloud > 80) {
      await add('satellite', 'high_cloud_cover', `Cloud cover ${cloud}% significantly reduces observation quality.`, [e.id], 'QUALITY_CHECK', 'LOW', e.geometry || null);
    }
  }

  // Sensor statistical outliers (real series, >3σ)
  const sensorEvidence = bySource['PHYSICAL_HARDWARE'] || [];
  const readingsByType: Record<string, { e: any; value: number }[]> = {};
  for (const e of sensorEvidence) {
    const v = Number((e.measurement as any)?.value);
    if (!Number.isFinite(v)) continue;
    const key = (e.measurement as any)?.sensor_type || e.sensor_id || 'unknown';
    if (!readingsByType[key]) readingsByType[key] = [];
    readingsByType[key].push({ e, value: v });
  }
  for (const [sensorType, readings] of Object.entries(readingsByType)) {
    if (readings.length < 4) continue;
    const mean = readings.reduce((s, r) => s + r.value, 0) / readings.length;
    const variance = readings.reduce((s, r) => s + (r.value - mean) ** 2, 0) / readings.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev <= 0) continue;
    for (const r of readings) {
      if (Math.abs(r.value - mean) > 3 * stdDev) {
        await add('sensor', 'outlier', `${sensorType} reading ${r.value}${r.e.unit || ''} is >3σ from series mean (${mean.toFixed(2)} ± ${stdDev.toFixed(2)}).`,
          [r.e.id], 'STATISTICAL_3SIGMA', 'MEDIUM', r.e.geometry || null);
      }
    }
  }

  // Cross-source inconsistency: weather vs sensor
  if (weatherEvidence.length > 0 && sensorEvidence.length > 0) {
    const w = weatherEvidence[0];
    const wm = w.measurement as any;
    const precipitation = wm?.precipitation ?? wm?.current?.precipitation;
    const soilSensors = sensorEvidence.filter((s) => (s.sensor_type || (s.measurement as any)?.sensor_type) === 'soil_moisture');
    for (const s of soilSensors) {
      const sm = Number((s.measurement as any)?.value);
      if (typeof precipitation === 'number' && precipitation > 10 && sm < 20) {
        await add('cross_source', 'weather_sensor_mismatch',
          `Heavy rainfall (${precipitation} mm) but soil moisture reads low (${sm}${s.unit || '%'}).`,
          [w.id, s.id], 'CROSS_SOURCE_CHECK', 'MEDIUM', s.geometry || null);
      }
    }
  }

  // Surface persisted anomalies only — no synthetic findings.
  const anomalies = await listAnomalies(fieldId, 200);
  return {
    anomalies,
    evidence_count: evidence.length,
    sources_analyzed: Array.from(sources),
    analysis_time: new Date().toISOString(),
  };
}
