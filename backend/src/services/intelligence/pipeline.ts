/**
 * Field intelligence pipeline.
 *
 * Evidence → data quality → fusion → World Model → anomaly → risk →
 * uncertainty → contradiction → investigation context → next best observation.
 *
 * This is the single orchestration used by POST /fields/:id/analyze and the
 * background analysis job. Every stage is persisted and field-scoped; provider
 * failures are recorded truthfully and never crash the pipeline.
 */
import { getField } from '../../data/fields';
import { fetchAndStoreWeather, fetchAndStoreSoil, fetchAndStoreTerrain, searchAndStoreSatellite } from '../providers/services';
import { analyzeField } from './anomaly-engine';
import { assessRisks } from './risk-engine';
import { assessUncertainty } from './uncertainty-engine';
import { detectContradictions } from './contradiction-engine';
import { buildWorldModel } from './world-model-builder';
import { emitEvent } from '../events';

export interface PipelineOptions {
  fetchWeather?: boolean;
  fetchSatellite?: boolean;
  fetchSoil?: boolean;
  fetchTerrain?: boolean;
}

export async function runFieldPipeline(fieldId: string, userId: string, opts: PipelineOptions = {}): Promise<Record<string, any>> {
  const field = await getField(fieldId, userId);
  if (!field) throw new Error('Field not found or not owned by user');

  const options: PipelineOptions = {
    fetchWeather: true,
    fetchSatellite: true,
    fetchSoil: opts.fetchSoil ?? false,
    fetchTerrain: opts.fetchTerrain ?? false,
    ...opts,
  };

  const results: Record<string, any> = {
    field_id: fieldId,
    analysis_time: new Date().toISOString(),
    providers: {},
    evidence_created: 0,
  };

  // 1. Provider ingestion (real calls; failures recorded truthfully)
  if (options.fetchWeather) {
    try {
      const w = await fetchAndStoreWeather(field, userId, 'current');
      results.providers.weather = { status: w.status, provider: w.provider, latency_ms: w.latency_ms, error: w.error };
      results.evidence_created += w.evidence_created;
    } catch (e: any) {
      results.providers.weather = { status: 'PROVIDER_ERROR', error: e.message };
    }
  }
  if (options.fetchSatellite) {
    try {
      const s = await searchAndStoreSatellite(field, userId, { providers: ['copernicus', 'landsat'], days: 60 });
      results.providers.satellite = { status: s.status, provider: s.provider, stored: s.stored, message: s.message, error: s.error };
      results.evidence_created += s.evidence_created;
    } catch (e: any) {
      results.providers.satellite = { status: 'PROVIDER_ERROR', error: e.message };
    }
  }
  if (options.fetchSoil) {
    try {
      const s = await fetchAndStoreSoil(field, userId);
      results.providers.soil = { status: s.status, provider: s.provider, message: s.message, error: s.error };
      results.evidence_created += s.evidence_created;
    } catch (e: any) {
      results.providers.soil = { status: 'PROVIDER_ERROR', error: e.message };
    }
  }
  if (options.fetchTerrain) {
    try {
      const t = await fetchAndStoreTerrain(field, userId);
      results.providers.terrain = { status: t.status, provider: t.provider, message: t.message, error: t.error };
      results.evidence_created += t.evidence_created;
    } catch (e: any) {
      results.providers.terrain = { status: 'PROVIDER_ERROR', error: e.message };
    }
  }

  // 2. Intelligence engines (persisted)
  const anomalies = await analyzeField(fieldId, userId);
  results.anomalies = anomalies.anomalies;
  results.anomaly_count = anomalies.anomalies.length;

  const risks = await assessRisks(fieldId, userId);
  results.risks = risks;
  results.risk_count = risks.length;

  const uncertainty = await assessUncertainty(fieldId, userId);
  results.uncertainty = uncertainty;

  const contradictions = await detectContradictions(fieldId, userId);
  results.contradictions = contradictions;
  results.contradiction_count = contradictions.length;

  // 3. World model (aggregates everything above)
  const worldModel = await buildWorldModel(field, userId);
  results.world_model = {
    state: worldModel.state,
    coverage: worldModel.coverage,
    evidence_gaps: worldModel.evidence_gaps,
    version: worldModel.version,
    evidenceCoverage: worldModel.coverage.total_evidence, // label: evidence coverage count
    last_updated: worldModel.last_updated,
    metrics_computed_by: worldModel.metrics_computed_by,
  };

  // 4. Qualitative assessment (no invented numbers)
  const evidenceCount = worldModel.coverage.total_evidence;
  const gapCount = worldModel.evidence_gaps.length;
  results.assessment = {
    evidence_sources: Object.keys(worldModel.coverage.by_source),
    evidence_count: evidenceCount,
    anomaly_count: anomalies.anomalies.length,
    risk_count: risks.length,
    contradiction_count: contradictions.length,
    evidence_gap_count: gapCount,
    recommendation: evidenceCount === 0
      ? 'INSUFFICIENT_EVIDENCE: No field evidence available — connect providers and run analysis again.'
      : anomalies.anomalies.length >= 3
        ? 'INVESTIGATE: Multiple anomalies detected — open an investigation before acting.'
        : contradictions.length > 0
          ? 'RESOLVE_CONTRADICTIONS: Conflicting evidence detected — investigate before acting.'
          : risks.some((r) => r.severity === 'HIGH' || r.severity === 'CRITICAL')
            ? 'ALERT: High-severity risk active — review the risk detail.'
            : 'MONITOR: Continue regular observation.',
  };

  await emitEvent('ANALYSIS_COMPLETED', { analysis_time: results.analysis_time, evidence_created: results.evidence_created }, { fieldId, userId }).catch(() => {});
  await emitEvent('WORLD_MODEL_UPDATED', { version: worldModel.version }, { fieldId, userId }).catch(() => {});
  return results;
}
