/**
 * Next Best Observation Engine
 *
 * Candidates are generated ONLY from real evidence-coverage gaps. Ranking is
 * qualitative (HIGH/MEDIUM/LOW with a rationale) — numerical information gain
 * is not implemented, so no numbers are produced.
 */
import { evidenceSummary } from '../../data/evidence';
import { listAnomalies, listContradictions } from '../../data/intel';

export interface NboCandidate {
  candidate: string;
  type: string;
  rationale: string;
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
}

export async function suggestNextObservations(fieldId: string): Promise<NboCandidate[]> {
  const summary = await evidenceSummary(fieldId);
  const anomalies = await listAnomalies(fieldId);
  const contradictions = await listContradictions(fieldId, true);

  const candidates: NboCandidate[] = [];

  if (!summary.by_source['EARTH_OBSERVATION']) {
    candidates.push({
      candidate: 'Acquire a Sentinel-2 acquisition over the field',
      type: 'satellite',
      rationale: 'No satellite evidence exists — vegetation state is entirely unknown; one acquisition establishes a baseline.',
      priority: 'HIGH',
    });
  } else if ((summary.by_source['EARTH_OBSERVATION'] || 0) < 2) {
    candidates.push({
      candidate: 'Acquire a second Sentinel-2 acquisition to enable change detection',
      type: 'satellite',
      rationale: 'A single product cannot show temporal change.',
      priority: 'MEDIUM',
    });
  }

  if (!summary.by_source['PHYSICAL_HARDWARE']) {
    candidates.push({
      candidate: 'Deploy or connect a soil moisture / soil temperature sensor',
      type: 'sensor',
      rationale: 'Root-zone conditions are unknown — no physical observation exists.',
      priority: anomalies.some((a) => a.type === 'cross_source' || a.type === 'moisture') ? 'HIGH' : 'MEDIUM',
    });
  }

  if (!summary.by_source['ENVIRONMENT']) {
    candidates.push({
      candidate: 'Fetch current weather and short-term forecast',
      type: 'weather',
      rationale: 'No atmospheric evidence — water and heat context missing.',
      priority: 'MEDIUM',
    });
  }

  if (!summary.by_source['FARMER_INPUT']) {
    candidates.push({
      candidate: 'Record a farmer observation (visual state, irrigation, recent activity)',
      type: 'farmer',
      rationale: 'Ground truth from the operator reduces interpretation ambiguity.',
      priority: 'MEDIUM',
    });
  }

  if (contradictions.length > 0) {
    candidates.push({
      candidate: 'Field inspection targeted at the contradicting evidence locations',
      type: 'inspection',
      rationale: `${contradictions.length} unresolved contradiction(s) — physical inspection is the decisive observation.`,
      priority: 'HIGH',
    });
  }

  if (anomalies.some((a) => a.type === 'temperature' || a.type === 'wind')) {
    candidates.push({
      candidate: 'Check crop canopy condition in the affected area',
      type: 'inspection',
      rationale: 'Temperature/wind anomalies were detected — visible crop response confirms or rejects impact.',
      priority: 'MEDIUM',
    });
  }

  return candidates;
}
