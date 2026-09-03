/**
 * Uncertainty Engine — separates DATA QUALITY / EVIDENCE COVERAGE / MODEL /
 * DECISION uncertainty. CRITICAL RULE: evidence count is never called
 * confidence, and no overall confidence percentage is fabricated. Coverage is
 * reported as a labelled evidence-coverage descriptor with per-domain states.
 */
import { listEvidence, evidenceSummary } from '../../data/evidence';
import { listAnomalies } from '../../data/intel';
import { storeUncertainty } from '../../data/intel';

const DAY_MS = 24 * 3600 * 1000;

export interface UncertaintyAssessment {
  field_id: string;
  data_quality: 'LOW' | 'MEDIUM' | 'HIGH' | 'NOT_ASSESSED';
  data_quality_explanation: string[];
  model_uncertainty: 'CALCULATED' | 'NOT_ASSESSED' | 'UNKNOWN';
  model_uncertainty_explanation: string[];
  decision_uncertainty: 'CALCULATED' | 'NOT_ASSESSED' | 'UNKNOWN';
  decision_uncertainty_explanation: string[];
  coverage: {
    domains: Record<string, string>;
    total_evidence: number;
    by_source: Record<string, number>;
    by_state: Record<string, number>;
    freshest: string | null;
    stalest: string | null;
    stale_domains: string[];
  };
  explanation: string[];
  assessed_at: string;
}

function freshnessLabel(observationTime: string | null | undefined): 'CURRENT' | 'RECENT' | 'STALE' | 'MISSING' {
  if (!observationTime) return 'MISSING';
  const age = Date.now() - new Date(observationTime).getTime();
  if (age < 24 * 3600 * 1000) return 'CURRENT';
  if (age < 7 * DAY_MS) return 'RECENT';
  return 'STALE';
}

export async function assessUncertainty(fieldId: string, userId: string): Promise<UncertaintyAssessment> {
  const evidence = await listEvidence({ fieldId, userId, limit: 1000 });
  const summary = await evidenceSummary(fieldId);
  const anomalies = await listAnomalies(fieldId);

  // Per-domain freshness from the freshest evidence item of each source.
  const sourceTimes: Record<string, string | null> = {};
  for (const e of evidence) {
    if (!sourceTimes[e.source] || e.observation_time > sourceTimes[e.source]!) {
      sourceTimes[e.source] = e.observation_time;
    }
  }

  const domains: Record<string, string> = {};
  const staleDomains: string[] = [];
  const domainSources: Record<string, string[]> = {
    weather: ['ENVIRONMENT'],
    satellite: ['EARTH_OBSERVATION'],
    sensors: ['PHYSICAL_HARDWARE'],
    soil: ['AGRICULTURE'],
    water: ['WATER'],
    terrain: ['ENVIRONMENT'],
    crop: ['AGRICULTURE'],
  };
  for (const [domain, sources] of Object.entries(domainSources)) {
    let best: string | null = null;
    for (const s of sources) {
      const t = sourceTimes[s];
      if (t && (!best || t > best)) best = t;
    }
    const fl = freshnessLabel(best);
    domains[domain] = best ? fl : 'MISSING';
    if (fl === 'STALE') staleDomains.push(domain);
  }

  const explanation: string[] = [];
  if (evidence.length === 0) explanation.push('NO_EVIDENCE: No evidence available for this field.');
  for (const [domain, state] of Object.entries(domains)) {
    if (state === 'MISSING') explanation.push(`${domain.toUpperCase()}_MISSING: No ${domain} evidence — ${domain} state unknown.`);
    if (state === 'STALE') explanation.push(`${domain.toUpperCase()}_STALE: ${domain} evidence is stale (>7 days).`);
  }
  if (anomalies.length > 0) explanation.push(`ANOMALIES: ${anomalies.length} anomaly(ies) detected — interpretation requires investigation.`);

  const assessment: UncertaintyAssessment = {
    field_id: fieldId,
    data_quality: 'NOT_ASSESSED',
    data_quality_explanation: [
      'Per-evidence quality assessments are stored with each record. Aggregate data-quality scoring is NOT_ASSESSED: no calibrated quality model exists for this field.',
    ],
    model_uncertainty: 'NOT_ASSESSED',
    model_uncertainty_explanation: [
      'No validated agronomic model has produced uncertainty estimates for this field.',
    ],
    decision_uncertainty: 'NOT_ASSESSED',
    decision_uncertainty_explanation: [
      'Decision-level uncertainty requires a validated decision model — none is configured.',
    ],
    coverage: {
      domains,
      total_evidence: summary.total,
      by_source: summary.by_source,
      by_state: summary.by_state,
      freshest: summary.freshest,
      stalest: summary.stalest,
      stale_domains: staleDomains,
    },
    explanation,
    assessed_at: new Date().toISOString(),
  };

  await storeUncertainty(fieldId, assessment as unknown as Record<string, unknown>);
  return assessment;
}
