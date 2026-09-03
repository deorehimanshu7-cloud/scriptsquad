/**
 * Contradiction Detection Engine
 *
 * Detects when real evidence from different sources disagrees, persists the
 * contradiction and links the conflicting evidence records with a CONTRADICTS
 * relationship. It never "picks a winner" — supporting/conflicting/missing
 * views are surfaced together for investigation.
 */
import { listEvidence, insertRelationship } from '../../data/evidence';
import { insertContradiction, findContradictionByPair, listContradictions, type ContradictionRow } from '../../data/intel';
import { generateId } from '../../database/sqlite';

export async function detectContradictions(fieldId: string, userId: string): Promise<ContradictionRow[]> {
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  const bySource: Record<string, any[]> = {};
  for (const e of evidence) {
    if (!bySource[e.source]) bySource[e.source] = [];
    bySource[e.source].push(e);
  }

  async function add(c: Omit<ContradictionRow, 'detected_at'>): Promise<void> {
    const existing = await findContradictionByPair(fieldId, c.type, c.evidence_a_id || null, c.evidence_b_id || null);
    if (existing) return;
    await insertContradiction(c);
    if (c.evidence_a_id && c.evidence_b_id && c.evidence_a_id !== c.evidence_b_id) {
      await insertRelationship({ sourceEvidenceId: c.evidence_a_id, targetEvidenceId: c.evidence_b_id, relationship: 'CONTRADICTS', rationale: c.description }).catch(() => {});
    }
  }

  // Weather vs soil-moisture sensor contradictions
  const weatherEvidence = bySource['ENVIRONMENT'] || [];
  const sensorEvidence = bySource['PHYSICAL_HARDWARE'] || [];
  // Evidence rows carry the sensor's identity (sensor_id/device_id) plus a
  // numeric measurement.value with unit '%' for moisture-class sensors.
  const soilSensors = sensorEvidence.filter((s) => {
    const m = (s.measurement || {}) as any;
    return typeof m.value === 'number' && (!s.unit || s.unit === '%');
  });

  for (const w of weatherEvidence.slice(0, 3)) {
    const wm = w.measurement as any;
    const precipitation = typeof wm?.precipitation === 'number' ? wm.precipitation : wm?.current?.precipitation;
    for (const s of soilSensors.slice(0, 3)) {
      const sm = Number((s.measurement as any)?.value);
      if (!Number.isFinite(precipitation) || !Number.isFinite(sm)) continue;
      if (precipitation > 10 && sm < 20) {
        await add({
          id: generateId(), field_id: fieldId, type: 'WEATHER_SENSOR_MISMATCH',
          description: `Heavy rainfall (${precipitation} mm) reported but soil moisture reads low (${sm}${s.unit || '%'}).`,
          evidence_a_id: w.id, evidence_b_id: s.id, source_a: w.source, source_b: s.source,
          state: 'DETECTED', severity: 'MEDIUM',
          hypothesis: 'Possible sensor calibration issue, delayed soil response, or spatial mismatch between weather grid cell and sensor location.',
        });
      }
      if ((precipitation === 0) && sm > 80) {
        await add({
          id: generateId(), field_id: fieldId, type: 'NO_RAIN_HIGH_MOISTURE',
          description: `No rainfall reported but soil moisture is high (${sm}${s.unit || '%'}) — possible unrecorded irrigation or sensor issue.`,
          evidence_a_id: w.id, evidence_b_id: s.id, source_a: w.source, source_b: s.source,
          state: 'DETECTED', severity: 'LOW',
          hypothesis: 'Irrigation activity not recorded, or sensor malfunction.',
        });
      }
    }
  }

  // Satellite observation reliability vs cloud cover
  const satEvidence = bySource['EARTH_OBSERVATION'] || [];
  for (const sat of satEvidence.slice(0, 3)) {
    const props = (sat.measurement as any)?.properties || {};
    const cloud = props['eo:cloud_cover'];
    if (typeof cloud === 'number' && cloud > 50 && sat.state === 'OBSERVED') {
      await add({
        id: generateId(), field_id: fieldId, type: 'CLOUDY_OBSERVATION',
        description: `Satellite observation carried ${cloud}% cloud cover — vegetation signal quality may be reduced.`,
        evidence_a_id: sat.id, evidence_b_id: sat.id, source_a: sat.source, source_b: sat.source,
        state: 'DETECTED', severity: 'LOW',
        hypothesis: 'Observation may still be usable after cloud masking, but reliability is reduced.',
      });
    }
  }

  return listContradictions(fieldId, true);
}
