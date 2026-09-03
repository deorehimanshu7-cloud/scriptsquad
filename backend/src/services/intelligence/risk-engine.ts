/**
 * Risk Engine (evidence-derived, truthful)
 *
 * Risks are produced ONLY from:
 *  - real detected anomalies (which are themselves derived from evidence)
 *  - genuine evidence-coverage gaps (observation gaps are risks of a distinct
 *    kind, never invented severities)
 * severity: derived from anomaly severity / data-gap nature.
 * uncertainty: 'NOT_ASSESSED' — no calibrated risk model exists; we never print
 * a percentage.
 */
import { listAnomalies, listRisks, insertRisk, findActiveRiskByTrigger, type RiskRow } from '../../data/intel';
import { listEvidence } from '../../data/evidence';
import { generateId } from '../../database/sqlite';

export async function assessRisks(fieldId: string, userId: string): Promise<RiskRow[]> {
  const anomalies = (await listAnomalies(fieldId)).filter((a) => a.state !== 'FALSE_POSITIVE');
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  async function add(risk: Omit<RiskRow, 'created_at'>): Promise<void> {
    const existing = await findActiveRiskByTrigger(fieldId, risk.trigger_reason || '');
    if (existing) return;
    await insertRisk(risk);
  }

  // Heat / wind / flood risks from real temperature/wind/rain anomalies
  const tempAnomalies = anomalies.filter((a) => a.type === 'temperature');
  const windAnomalies = anomalies.filter((a) => a.type === 'wind');
  const moistureAnomalies = anomalies.filter((a) => a.type === 'moisture' || a.type === 'cross_source');

  for (const a of tempAnomalies) {
    const high = a.subtype === 'high_temp';
    await add({
      id: generateId(), field_id: fieldId,
      type: high ? 'heat' : 'weather', severity: a.severity || 'MEDIUM',
      time_horizon: high ? '24-72h' : '24-48h', affected_geometry: a.geometry || null,
      evidence_ids: a.evidence_ids, status: 'ACTIVE',
      description: `${high ? 'Heat stress' : 'Frost risk'}: ${a.description}`,
      trigger_reason: `ANOMALY:${a.type}:${a.subtype}`, uncertainty: 'NOT_ASSESSED',
    });
  }
  for (const a of windAnomalies) {
    await add({
      id: generateId(), field_id: fieldId, type: 'wind_damage', severity: a.severity || 'MEDIUM',
      time_horizon: '12-48h', affected_geometry: a.geometry || null,
      evidence_ids: a.evidence_ids, status: 'ACTIVE', description: `Wind damage risk: ${a.description}`,
      trigger_reason: `ANOMALY:${a.type}`, uncertainty: 'NOT_ASSESSED',
    });
  }
  for (const a of moistureAnomalies) {
    await add({
      id: generateId(), field_id: fieldId, type: 'water_stress', severity: a.severity || 'MEDIUM',
      time_horizon: '48-120h', affected_geometry: a.geometry || null,
      evidence_ids: a.evidence_ids, status: 'ACTIVE',
      description: `Possible water stress / soil-water mismatch: ${a.description}`,
      trigger_reason: `ANOMALY:${a.type}:${a.subtype}`, uncertainty: 'NOT_ASSESSED',
    });
  }

  // Genuine coverage gaps (these are facts, not guesses)
  const sources = new Set(evidence.map((e) => e.source));
  if (!sources.has('EARTH_OBSERVATION')) {
    await add({
      id: generateId(), field_id: fieldId, type: 'observation_gap', severity: 'LOW',
      time_horizon: '14-30d', affected_geometry: null, evidence_ids: [], status: 'ACTIVE',
      description: 'No satellite observation available — vegetation state is unknown.',
      trigger_reason: 'DATA_GAP:EARTH_OBSERVATION', uncertainty: 'NOT_ASSESSED',
    });
  }
  if (!sources.has('PHYSICAL_HARDWARE')) {
    await add({
      id: generateId(), field_id: fieldId, type: 'observation_gap', severity: 'LOW',
      time_horizon: '30d+', affected_geometry: null, evidence_ids: [], status: 'ACTIVE',
      description: 'No sensor data available — root-zone conditions are unknown.',
      trigger_reason: 'DATA_GAP:PHYSICAL_HARDWARE', uncertainty: 'NOT_ASSESSED',
    });
  }

  if (anomalies.length >= 3) {
    const ids = anomalies.flatMap((a) => a.evidence_ids);
    await add({
      id: generateId(), field_id: fieldId, type: 'multi_anomaly', severity: 'HIGH',
      time_horizon: '24-72h', affected_geometry: null, evidence_ids: ids, status: 'ACTIVE',
      description: `${anomalies.length} distinct anomalies detected across evidence sources — elevated need for investigation.`,
      trigger_reason: 'ANOMALY_CORRELATION', uncertainty: 'NOT_ASSESSED',
    });
  }

  return listRisks(fieldId, true);
}
