/**
 * Core integration tests (sqlite-dev). Field lifecycle, server-side field
 * isolation (A→B→C), engine truthfulness and AI no-invention guarantees.
 */
import { createUser, findUserByEmail } from '../src/data/users';
import { createFarm } from '../src/data/users';
import { createField, getField, listFields, fieldBelongsToUser, updateFieldGeometry, getFieldFarm } from '../src/data/fields';
import { insertEvidence, listEvidence, evidenceSummary } from '../src/data/evidence';
import { analyzeField } from '../src/services/intelligence/anomaly-engine';
import { assessRisks } from '../src/services/intelligence/risk-engine';
import { assessUncertainty } from '../src/services/intelligence/uncertainty-engine';
import { detectContradictions } from '../src/services/intelligence/contradiction-engine';
import { buildWorldModel } from '../src/services/intelligence/world-model-builder';
import { createInvestigation, listInvestigations } from '../src/data/intel';
import { processAssistantMessage } from '../src/services/ai/llm-service';
import { runFieldPipeline } from '../src/services/intelligence/pipeline';
import { listWeatherObservations } from '../src/data/evidence';

const geometry: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[
    [75.84, 18.51], [75.85, 18.51], [75.85, 18.52], [75.84, 18.52], [75.84, 18.51],
  ]],
};

async function makeUser(email: string) {
  return createUser({ email, password: 'password-123' });
}

let userA: any, userB: any, farmA: any, farmB: any;

beforeAll(async () => {
  userA = await makeUser('a@test.local');
  userB = await makeUser('b@test.local');
  farmA = await createFarm({ userId: userA.id, name: 'Farm A' });
  farmB = await createFarm({ userId: userB.id, name: 'Farm B' });
});

describe('field lifecycle & canonical geometry', () => {
  let fieldA: any;
  test('create field computes metrics from geometry', async () => {
    fieldA = await createField({ userId: userA.id, farmId: farmA.id, name: 'Field A', geometry });
    expect(fieldA.id).toBeTruthy();
    expect(fieldA.area_hectares).toBeGreaterThan(90);
    expect(fieldA.area_hectares).toBeLessThan(120);
    expect(fieldA.centroid.coordinates.length).toBe(2);
    expect(fieldA.metrics_computed_by).toBe('sqlite-dev-geo');
    expect(fieldA.geometry_valid).toBe(true);
  });

  test('field persists and geometry updates are versioned', async () => {
    const fetched = await getField(fieldA.id, userA.id);
    expect(fetched!.name).toBe('Field A');
    const bigger: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[75.83, 18.50], [75.86, 18.50], [75.86, 18.53], [75.83, 18.53], [75.83, 18.50]]],
    };
    const updated = await updateFieldGeometry({ fieldId: fieldA.id, userId: userA.id, farmId: farmA.id, geometry: bigger });
    expect(updated!.area_hectares).toBeGreaterThan(800);
    const versions = await (await import('../src/data/fields')).listGeometryVersions(fieldA.id);
    expect(versions.length).toBeGreaterThanOrEqual(1);
  });

  test('field isolation: user B cannot see or touch field A', async () => {
    expect(await getField(fieldA.id, userB.id)).toBeNull();
    expect(await fieldBelongsToUser(fieldA.id, userB.id)).toBe(false);
    const bList = await listFields(userB.id);
    expect(bList.some((f: any) => f.id === fieldA.id)).toBe(false);
    const fieldB = await createField({ userId: userB.id, farmId: farmB.id, name: 'Field B', geometry });
    expect(await getField(fieldB.id, userA.id)).toBeNull();
    expect(await getFieldFarm(fieldA.id)).toEqual({ farm_id: farmA.id, user_id: userA.id });
  });
});

describe('evidence pipeline & truthful engines', () => {
  let fieldA: any;
  beforeAll(async () => {
    const f = await listFields(userA.id);
    fieldA = f[0];
  });

  test('evidence inserts and stays field-scoped', async () => {
    await insertEvidence({
      userId: userA.id, farmId: farmA.id, fieldId: fieldA.id,
      source: 'ENVIRONMENT', provider: 'open-meteo',
      observationTime: new Date().toISOString(),
      measurement: { temperature: 45, precipitation: 0, wind_speed: 60 },
      state: 'MODEL_DERIVED', quality: null, provenance: { provider: 'open-meteo' },
    });
    await insertEvidence({
      userId: userA.id, farmId: farmA.id, fieldId: fieldA.id,
      source: 'EARTH_OBSERVATION', provider: 'copernicus',
      observationTime: new Date().toISOString(),
      measurement: { product_id: 'S2A_TEST', properties: { 'eo:cloud_cover': 85 } },
      state: 'OBSERVED', quality: null, provenance: { product_id: 'S2A_TEST' },
    });
    const rows = await listEvidence({ fieldId: fieldA.id, userId: userA.id });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(await listEvidence({ fieldId: fieldA.id, userId: userB.id })).toHaveLength(0);
    const summary = await evidenceSummary(fieldA.id);
    expect(summary.by_source['ENVIRONMENT']).toBeGreaterThanOrEqual(1);
  });

  test('anomaly engine detects high temperature & cloud from real evidence', async () => {
    const result = await analyzeField(fieldA.id, userA.id);
    const types = result.anomalies.map((a: any) => a.type);
    expect(types).toContain('temperature');
    expect(types).toContain('satellite');
    const anomaly = result.anomalies.find((a: any) => a.type === 'temperature')!;
    expect(anomaly.quality).toBeNull(); // NOT_ASSESSED — never fabricated
    expect(anomaly.evidence_ids.length).toBeGreaterThan(0);
  });

  test('risk engine derives risks from anomalies; uncertainty is NOT_ASSESSED', async () => {
    const risks = await assessRisks(fieldA.id, userA.id);
    expect(risks.some((r: any) => r.type === 'heat')).toBe(true);
    for (const r of risks) expect(r.uncertainty).toBe('NOT_ASSESSED');
    const u = await assessUncertainty(fieldA.id, userA.id);
    expect(u.coverage.total_evidence).toBeGreaterThanOrEqual(2);
    expect(u.data_quality).toBe('NOT_ASSESSED');
    expect(u.model_uncertainty).toBe('NOT_ASSESSED');
    expect(JSON.stringify(u)).not.toMatch(/confidence/i);
  });

  test('world model aggregates evidence; coverage is labelled EVIDENCE_COVERAGE', async () => {
    const field = await getField(fieldA.id, userA.id);
    const wm = await buildWorldModel(field!, userA.id);
    expect(wm.state.weather.state).toBe('MODEL_DERIVED');
    expect(wm.state.satellite.state).toBe('OBSERVED');
    expect(wm.coverage.label).toBe('EVIDENCE_COVERAGE');
    expect(JSON.stringify(wm)).not.toMatch(/"confidence"/i);
    expect(wm.version).toBeGreaterThanOrEqual(1);
  });

  test('contradiction engine + investigation lifecycle', async () => {
    // rainy weather evidence + dry soil-moisture sensor → contradiction
    await insertEvidence({
      userId: userA.id, farmId: farmA.id, fieldId: fieldA.id,
      source: 'ENVIRONMENT', provider: 'open-meteo',
      observationTime: new Date().toISOString(),
      measurement: { precipitation: 25, temperature: 22 },
      state: 'MODEL_DERIVED', quality: null, provenance: { provider: 'open-meteo' },
    });
    await insertEvidence({
      userId: userA.id, farmId: farmA.id, fieldId: fieldA.id,
      source: 'PHYSICAL_HARDWARE', provider: 'agrifur2-device', sensorId: 'sensor-1',
      observationTime: new Date().toISOString(),
      measurement: { value: 5 }, unit: '%', state: 'OBSERVED',
      quality: null, provenance: { device: 'dev-1' },
    });
    const contradictions = await detectContradictions(fieldA.id, userA.id);
    expect(contradictions.some((c: any) => c.type === 'WEATHER_SENSOR_MISMATCH')).toBe(true);
    const inv = await createInvestigation({ fieldId: fieldA.id, userId: userA.id, title: 'Why is soil dry after rain?', question: 'Soil reads dry although rain was recorded.' });
    expect(inv.id).toBeTruthy();
    const list = await listInvestigations(fieldA.id, userA.id);
    expect(list.length).toBeGreaterThanOrEqual(1);
  });

  test('pipeline runs offline-safe (no providers) and returns qualitative assessment', async () => {
    const field = await getField(fieldA.id, userA.id);
    const res = await runFieldPipeline(field!.id, userA.id, {
      fetchWeather: false, fetchSatellite: false, fetchSoil: false, fetchTerrain: false,
    });
    expect(res.assessment.recommendation).toBeTruthy();
    expect(res.world_model.coverage.label).toBe('EVIDENCE_COVERAGE');
  });
});

describe('AI safety — never invents', () => {
  test('empty-data field answer states data is unavailable without numbers', async () => {
    const user = await makeUser('c@test.local');
    const farm = await createFarm({ userId: user.id, name: 'Farm C' });
    const field = await createField({ userId: user.id, farmId: farm.id, name: 'Empty', geometry });
    const ai = await processAssistantMessage({ fieldId: field.id, userId: user.id, message: 'What is happening in this field?' });
    expect(ai.content.toLowerCase()).toMatch(/not available|no .*evidence|unavailable/);
    expect(ai.content).not.toMatch(/confidence:?\s*\d/);
    expect(ai.content).not.toMatch(/\d+\s*%\s*confidence/i);
    expect(ai.providerStatus).toBe('AUTH_REQUIRED'); // no AI_API_KEY in tests
    expect(ai.toolCalls.length).toBeGreaterThan(0);
  });

  test('unknown pH/EC are not guessed', async () => {
    const user = await makeUser('d@test.local');
    const farm = await createFarm({ userId: user.id, name: 'Farm D' });
    const field = await createField({ userId: user.id, farmId: farm.id, name: 'D', geometry });
    const ai = await processAssistantMessage({ fieldId: field.id, userId: user.id, message: 'What is the soil pH and EC?' });
    expect(ai.content).not.toMatch(/pH\s*(is|=)\s*\d/);
    expect(ai.content).not.toMatch(/EC\s*(is|=)\s*\d/);
  });
});
