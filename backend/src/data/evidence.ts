/**
 * Evidence repository — evidence records, relationships, satellite products
 * and environmental (weather/water/soil/terrain) stores. Every row is
 * field-scoped; all queries join ownership through the caller-provided
 * user/field context (field isolation is enforced at the route layer).
 */
import { dbAll, dbGet, dbRun, GEO } from './db';
import { generateId } from '../database/sqlite';
import type { EvidenceState, QualityAssessment, Provenance, EvidenceProcessing } from '@agrifur2/shared';

// ── Evidence ────────────────────────────────────────────────────────────────
export interface EvidenceRow {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  source: string;
  provider?: string;
  geometry?: GeoJSON.Geometry | null;
  observation_time: string;
  retrieved_at: string;
  measurement: Record<string, unknown>;
  unit?: string;
  state: EvidenceState | string;
  quality: QualityAssessment | null;
  processing: EvidenceProcessing;
  provenance: Provenance;
  uncertainty: unknown;
  depth_meters?: number | null;
  device_id?: string | null;
  sensor_id?: string | null;
  created_at: string;
}

const EV_SELECT = `SELECT e.id, e.user_id, e.farm_id, e.field_id, e.source, e.provider,
  ${GEO.toJson('e.geometry', 'geometry')}, e.observation_time, e.retrieved_at, e.measurement,
  e.unit, e.state, e.quality, e.processing, e.provenance, e.uncertainty, e.depth_meters,
  e.device_id, e.sensor_id, e.created_at FROM evidence e`;

export interface CreateEvidenceInput {
  userId: string;
  farmId: string;
  fieldId: string;
  source: string;
  provider?: string;
  geometry?: GeoJSON.Geometry | null;
  observationTime: string;
  measurement: Record<string, unknown>;
  unit?: string;
  state: EvidenceState | string;
  quality?: QualityAssessment | null;
  processing?: EvidenceProcessing;
  provenance?: Provenance;
  uncertainty?: unknown;
  depthMeters?: number | null;
  deviceId?: string | null;
  sensorId?: string | null;
}

export async function insertEvidence(input: CreateEvidenceInput): Promise<EvidenceRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO evidence (id, user_id, farm_id, field_id, source, provider, geometry,
      observation_time, retrieved_at, measurement, unit, state, quality, processing,
      provenance, uncertainty, depth_meters, device_id, sensor_id)
     VALUES ($1,$2,$3,$4,$5,$6,${GEO.fromJson('$7')},$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [id, input.userId, input.farmId, input.fieldId, input.source, input.provider || null,
     input.geometry ? JSON.stringify(input.geometry) : null,
     input.observationTime, new Date().toISOString(), input.measurement, input.unit || null,
     input.state, input.quality ?? null, input.processing || { processed: false, steps: [] },
     input.provenance || {}, input.uncertainty ?? null, input.depthMeters ?? null,
     input.deviceId || null, input.sensorId || null]
  );
  const row = await getEvidence(id, input.userId);
  if (!row) throw new Error('Evidence insert failed');
  return row;
}

export async function getEvidence(id: string, userId: string): Promise<EvidenceRow | null> {
  return (await dbGet(`${EV_SELECT} WHERE e.id = $1 AND e.user_id = $2`, [id, userId])) as EvidenceRow | null;
}

export async function listEvidence(input: { fieldId: string; userId: string; source?: string; limit?: number }): Promise<EvidenceRow[]> {
  const where = ['e.field_id = $1', 'e.user_id = $2'];
  const params: any[] = [input.fieldId, input.userId];
  if (input.source) { where.push(`e.source = $${params.length + 1}`); params.push(input.source); }
  const limit = input.limit || 500;
  return (await dbAll(
    `${EV_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.observation_time DESC LIMIT ${limit}`, params
  )) as EvidenceRow[];
}

export async function countEvidence(fieldId: string): Promise<number> {
  const r = (await dbGet(`SELECT COUNT(*) AS c FROM evidence WHERE field_id = $1`, [fieldId])) as any;
  return Number(r?.c || 0);
}

export async function evidenceSummary(fieldId: string): Promise<{ total: number; by_source: Record<string, number>; by_state: Record<string, number>; freshest: string | null; stalest: string | null }> {
  const rows = await dbAll(`SELECT source, state, observation_time FROM evidence WHERE field_id = $1`, [fieldId]);
  const by_source: Record<string, number> = {};
  const by_state: Record<string, number> = {};
  let freshest: string | null = null;
  let stalest: string | null = null;
  for (const r of rows) {
    by_source[r.source] = (by_source[r.source] || 0) + 1;
    by_state[r.state] = (by_state[r.state] || 0) + 1;
    if (!freshest || r.observation_time > freshest) freshest = r.observation_time;
    if (!stalest || r.observation_time < stalest) stalest = r.observation_time;
  }
  return { total: rows.length, by_source, by_state, freshest, stalest };
}

// ── Relationships ───────────────────────────────────────────────────────────
export async function insertRelationship(input: { sourceEvidenceId: string; targetEvidenceId: string; relationship: string; rationale?: string }): Promise<void> {
  const existing = await dbGet(
    `SELECT id FROM evidence_relationships WHERE source_evidence_id = $1 AND target_evidence_id = $2 AND relationship = $3`,
    [input.sourceEvidenceId, input.targetEvidenceId, input.relationship]
  );
  if (existing) return;
  await dbRun(
    `INSERT INTO evidence_relationships (id, source_evidence_id, target_evidence_id, relationship, rationale)
     VALUES ($1,$2,$3,$4,$5)`,
    [generateId(), input.sourceEvidenceId, input.targetEvidenceId, input.relationship, input.rationale || null]
  );
}

export async function listRelationships(fieldId: string): Promise<any[]> {
  return dbAll(
    `SELECT er.id, er.source_evidence_id, er.target_evidence_id, er.relationship, er.rationale, er.created_at
     FROM evidence_relationships er
     JOIN evidence e ON e.id = er.source_evidence_id OR e.id = er.target_evidence_id
     WHERE e.field_id = $1 GROUP BY er.id ORDER BY er.created_at DESC`, [fieldId]
  );
}

export async function deleteRelationshipsForEvidence(evidenceId: string): Promise<void> {
  await dbRun(`DELETE FROM evidence_relationships WHERE source_evidence_id = $1 OR target_evidence_id = $1`, [evidenceId]);
}

// ── Satellite products ──────────────────────────────────────────────────────
export interface SatelliteProductRow {
  id: string;
  provider_id: string;
  collection: string;
  product_id: string;
  field_id?: string;
  geometry?: GeoJSON.Geometry | null;
  cloud_cover?: number | null;
  observation_date: string;
  assets: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

const SAT_SELECT = `SELECT s.id, s.provider_id, s.collection, s.product_id, s.field_id,
  ${GEO.toJson('s.geometry', 'geometry')}, s.cloud_cover, s.observation_date, s.assets,
  s.metadata, s.created_at FROM satellite_products s`;

export async function insertSatelliteProduct(input: {
  providerId: string; collection: string; productId: string; fieldId?: string;
  geometry?: GeoJSON.Geometry | null; cloudCover?: number | null; observationDate: string;
  assets?: Record<string, unknown>; metadata?: Record<string, unknown>;
}): Promise<SatelliteProductRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO satellite_products (id, provider_id, collection, product_id, field_id, geometry, cloud_cover, observation_date, assets, metadata)
     VALUES ($1,$2,$3,$4,$5,${GEO.fromJson('$6')},$7,$8,$9,$10)`,
    [id, input.providerId, input.collection, input.productId, input.fieldId || null,
     input.geometry ? JSON.stringify(input.geometry) : null, input.cloudCover ?? null,
     input.observationDate, input.assets || {}, input.metadata || {}]
  );
  return (await dbGet(`${SAT_SELECT} WHERE s.id = $1`, [id])) as SatelliteProductRow;
}

export async function listSatelliteProducts(fieldId: string, limit = 50): Promise<SatelliteProductRow[]> {
  return (await dbAll(`${SAT_SELECT} WHERE s.field_id = $1 ORDER BY s.observation_date DESC LIMIT ${limit}`, [fieldId])) as SatelliteProductRow[];
}

export async function findSatelliteProduct(fieldId: string, providerId: string, productId: string): Promise<SatelliteProductRow | null> {
  return (await dbGet(`${SAT_SELECT} WHERE s.field_id = $1 AND s.provider_id = $2 AND s.product_id = $3`, [fieldId, providerId, productId])) as SatelliteProductRow | null;
}

// ── Weather ─────────────────────────────────────────────────────────────────
export async function insertWeatherObservation(input: { fieldId: string; provider?: string; timestamp: string; kind: string; semantics: string; data: Record<string, unknown> }): Promise<void> {
  await dbRun(
    `INSERT INTO weather_observations (id, field_id, provider, "timestamp", kind, semantics, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [generateId(), input.fieldId, input.provider || null, input.timestamp, input.kind, input.semantics, input.data]
  );
}

export async function latestWeatherObservation(fieldId: string, kind: string): Promise<any | null> {
  return dbGet(`SELECT * FROM weather_observations WHERE field_id = $1 AND kind = $2 ORDER BY "timestamp" DESC LIMIT 1`, [fieldId, kind]);
}

export async function listWeatherObservations(fieldId: string, kind?: string, limit = 200): Promise<any[]> {
  const where = ['field_id = $1'];
  const params: any[] = [fieldId];
  if (kind) { where.push('kind = $2'); params.push(kind); }
  return dbAll(`SELECT * FROM weather_observations WHERE ${where.join(' AND ')} ORDER BY "timestamp" DESC LIMIT ${limit}`, params);
}

// ── Soil ────────────────────────────────────────────────────────────────────
export interface SoilObservationRow {
  id: string; field_id: string; property: string; value: number | null; unit: string;
  state: string; source?: string; timestamp?: string; quality: QualityAssessment | null;
  uncertainty: unknown; provenance: Provenance; retrieved_at: string;
}
export async function upsertSoilObservation(input: Omit<SoilObservationRow, 'id' | 'retrieved_at'>): Promise<void> {
  const existing = await dbGet(`SELECT id FROM soil_observations WHERE field_id = $1 AND property = $2 ORDER BY retrieved_at DESC LIMIT 1`, [input.field_id, input.property]);
  if (existing) {
    await dbRun(`UPDATE soil_observations SET value=$1, unit=$2, state=$3, source=$4, "timestamp"=$5, quality=$6, uncertainty=$7, provenance=$8 WHERE id=$9`,
      [input.value, input.unit, input.state, input.source || null, input.timestamp || null, input.quality ?? null, input.uncertainty ?? null, input.provenance || {}, existing.id]);
    return;
  }
  await dbRun(
    `INSERT INTO soil_observations (id, field_id, property, value, unit, state, source, "timestamp", quality, uncertainty, provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [generateId(), input.field_id, input.property, input.value, input.unit, input.state, input.source || null, input.timestamp || null, input.quality ?? null, input.uncertainty ?? null, input.provenance || {}]
  );
}
export async function listSoilObservations(fieldId: string): Promise<SoilObservationRow[]> {
  return (await dbAll(`SELECT * FROM soil_observations WHERE field_id = $1 ORDER BY property, retrieved_at DESC`, [fieldId])) as SoilObservationRow[];
}

// ── Water / Terrain ─────────────────────────────────────────────────────────
export async function upsertWaterObservation(input: { fieldId: string; domain: string; state: string; data: Record<string, unknown>; provider?: string; observedAt?: string }): Promise<void> {
  const existing = await dbGet(`SELECT id FROM water_observations WHERE field_id = $1 AND domain = $2`, [input.fieldId, input.domain]);
  if (existing) {
    await dbRun(`UPDATE water_observations SET state=$1, data=$2, provider=$3, observed_at=$4 WHERE id=$5`,
      [input.state, input.data, input.provider || null, input.observedAt || null, existing.id]);
    return;
  }
  await dbRun(
    `INSERT INTO water_observations (id, field_id, domain, state, data, provider, observed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [generateId(), input.fieldId, input.domain, input.state, input.data, input.provider || null, input.observedAt || null]
  );
}
export async function listWaterObservations(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM water_observations WHERE field_id = $1`, [fieldId]);
}
export async function upsertTerrainProduct(input: { fieldId: string; kind: string; state: string; data: Record<string, unknown>; provider?: string }): Promise<void> {
  const existing = await dbGet(`SELECT id FROM terrain_products WHERE field_id = $1 AND kind = $2`, [input.fieldId, input.kind]);
  if (existing) {
    await dbRun(`UPDATE terrain_products SET state=$1, data=$2, provider=$3 WHERE id=$4`, [input.state, input.data, input.provider || null, existing.id]);
    return;
  }
  await dbRun(
    `INSERT INTO terrain_products (id, field_id, kind, state, data, provider) VALUES ($1,$2,$3,$4,$5,$6)`,
    [generateId(), input.fieldId, input.kind, input.state, input.data, input.provider || null]
  );
}
export async function listTerrainProducts(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM terrain_products WHERE field_id = $1`, [fieldId]);
}
