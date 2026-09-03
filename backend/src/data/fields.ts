/**
 * Fields repository — canonical spatial truth.
 *
 * postgres : field metrics (area_m2, area_hectares, perimeter_m, centroid,
 *            bbox, validity) are computed by PostGIS triggers using
 *            ST_Transform(ST_Area/ST_Perimeter, local equal-area UTM),
 *            ST_Centroid, ST_Envelope, ST_IsValid. Stored geometry is the only
 *            geometry that drives maps, evidence AOIs, the World Model, the
 *            satellite search and the Digital Twin.
 * sqlite-dev: geometry stored as GeoJSON; metrics computed by shared/geo and
 *            flagged computed_by: 'sqlite-dev-geo'. Never presented as PostGIS.
 */
import { dbAll, dbGet, dbRun, dbTx, GEO, isPostgres } from './db';
import { generateId } from '../database/sqlite';
import { computeMetrics, validatePolygon, type GeoMetrics } from '@agrifur2/shared';

export interface FieldRow {
  id: string;
  farm_id: string;
  user_id: string;
  name: string;
  geometry: GeoJSON.Polygon;
  geometry_valid: boolean | null;
  area_m2: number | null;
  area_hectares: number | null;
  perimeter_m: number | null;
  centroid: GeoJSON.Point | null;
  bbox: GeoJSON.BBox | null;
  srid: number;
  status: 'active' | 'inactive' | 'archived';
  metrics_computed_by?: 'postgis' | 'sqlite-dev-geo';
  created_at: string;
  updated_at: string;
}

function fieldSelect(a: string): string {
  return `SELECT ${a}.id, ${a}.farm_id, ${a}.user_id, ${a}.name,
    ${GEO.toJson(`${a}.geometry`, 'geometry')}, ${a}.geometry_valid,
    ${a}.area_m2, ${a}.area_hectares, ${a}.perimeter_m,
    ${GEO.toJson(`${a}.centroid`, 'centroid')}, ${GEO.toJson(`${a}.bbox`, 'bbox')},
    ${a}.srid, ${a}.status, ${a}.created_at, ${a}.updated_at FROM fields ${a}`;
}

function parseField(row: any): FieldRow {
  const r: Record<string, any> = { ...row };
  if (r.geometry && typeof r.geometry === 'string') { try { r.geometry = JSON.parse(r.geometry); } catch { r.geometry = null; } }
  if (r.centroid && typeof r.centroid === 'string') { try { r.centroid = JSON.parse(r.centroid); } catch { r.centroid = null; } }
  if (r.bbox && typeof r.bbox === 'string') {
    try {
      const parsed = JSON.parse(r.bbox);
      if (parsed?.coordinates?.[0]) r.bbox = flattenBbox(parsed);
      else r.bbox = parsed;
    } catch { r.bbox = null; }
  }
  if (r.geometry_valid !== null && r.geometry_valid !== undefined) r.geometry_valid = r.geometry_valid === true || r.geometry_valid === 1;
  r.metrics_computed_by = isPostgres() ? 'postgis' : 'sqlite-dev-geo';
  return r as FieldRow;
}

function flattenBbox(env: any): GeoJSON.BBox {
  const xs = env.coordinates[0].map((c: number[]) => c[0]);
  const ys = env.coordinates[0].map((c: number[]) => c[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export async function listFields(userId: string): Promise<FieldRow[]> {
  const rows = await dbAll(`${fieldSelect('f')} WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [userId]);
  return rows.map(parseField);
}

export async function getField(fieldId: string, userId?: string): Promise<FieldRow | null> {
  const row = userId
    ? await dbGet(`${fieldSelect('f')} WHERE f.id = $1 AND f.user_id = $2`, [fieldId, userId])
    : await dbGet(`${fieldSelect('f')} WHERE f.id = $1`, [fieldId]);
  return row ? parseField(row) : null;
}

export async function fieldBelongsToUser(fieldId: string, userId: string): Promise<boolean> {
  const row = await dbGet(`SELECT 1 AS ok FROM fields WHERE id = $1 AND user_id = $2`, [fieldId, userId]);
  return !!row;
}

export async function getFieldFarm(fieldId: string): Promise<{ farm_id: string; user_id: string } | null> {
  return (await dbGet(`SELECT farm_id, user_id FROM fields WHERE id = $1`, [fieldId])) as any;
}

/** Validate geometry; returns issue list (empty = OK). */
export function validateFieldGeometry(geometry: GeoJSON.Polygon): { code: string; message: string }[] {
  return validatePolygon(geometry);
}

export interface CreateFieldInput {
  userId: string;
  farmId: string;
  name: string;
  geometry: GeoJSON.Polygon;
}

export async function createField(input: CreateFieldInput): Promise<FieldRow> {
  const id = generateId();
  const geoJson = JSON.stringify(input.geometry);
  if (isPostgres()) {
    const row = await dbGet(
      `INSERT INTO fields (id, farm_id, user_id, name, geometry, status)
       VALUES ($1, $2, $3, $4, ${GEO.fromJson('$5')}, 'active')
       RETURNING id, farm_id, user_id, name, ${GEO.toJson('geometry', 'geometry')},
         geometry_valid, area_m2, area_hectares, perimeter_m,
         ${GEO.toJson('centroid', 'centroid')}, ${GEO.toJson('bbox', 'bbox')},
         srid, status, created_at, updated_at`,
      [id, input.farmId, input.userId, input.name, geoJson]
    );
    if (!row) throw new Error('Field creation failed');
    return parseField(row);
  }
  // sqlite-dev: metrics from shared geodesic utilities, clearly labelled
  const metrics = computeMetrics(input.geometry);
  const valid = validatePolygon(input.geometry).length === 0;
  await dbRun(
    `INSERT INTO fields (id, farm_id, user_id, name, geometry, geometry_valid, area_m2, area_hectares, perimeter_m, centroid, bbox, srid, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')`,
    [id, input.farmId, input.userId, input.name, geoJson,
     valid ? 1 : null, round2(metrics.area_m2), round4(metrics.area_hectares), round2(metrics.perimeter_m),
     JSON.stringify(metrics.centroid), JSON.stringify(bboxGeo(metrics)), metrics.srid]
  );
  const field = await getField(id, input.userId);
  if (!field) throw new Error('Field creation failed');
  return field;
}

export async function updateFieldGeometry(input: { fieldId: string; userId: string; farmId: string; geometry: GeoJSON.Polygon }): Promise<FieldRow | null> {
  const existing = await getField(input.fieldId, input.userId);
  if (!existing) return null;
  const geoJson = JSON.stringify(input.geometry);
  // version bump (canonical geometry history)
  const cur = (await dbGet(`SELECT COALESCE(MAX(version), 0) AS v FROM field_geometry_versions WHERE field_id = $1`, [input.fieldId])) as any;
  const nextVersion = (cur?.v || 0) + 1;

  if (isPostgres()) {
    await dbTx(async () => {
      await dbRun(
        `INSERT INTO field_geometry_versions (id, field_id, geometry, version, created_by)
         VALUES ($1, $2, ${GEO.fromJson('$3')}, $4, $5)`,
        [generateId(), input.fieldId, geoJson, nextVersion, input.userId]
      );
      await dbRun(
        `UPDATE fields SET geometry = ${GEO.fromJson('$1')}, updated_at = $2 WHERE id = $3`,
        [geoJson, new Date().toISOString(), input.fieldId]
      );
    });
  } else {
    const metrics = computeMetrics(input.geometry);
    const valid = validatePolygon(input.geometry).length === 0;
    await dbTx(async () => {
      await dbRun(
        `INSERT INTO field_geometry_versions (id, field_id, geometry, version, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [generateId(), input.fieldId, geoJson, nextVersion, input.userId]
      );
      await dbRun(
        `UPDATE fields SET geometry = $1, geometry_valid = $2, area_m2 = $3, area_hectares = $4,
           perimeter_m = $5, centroid = $6, bbox = $7, updated_at = $8 WHERE id = $9`,
        [geoJson, valid ? 1 : null, round2(metrics.area_m2), round4(metrics.area_hectares), round2(metrics.perimeter_m),
         JSON.stringify(metrics.centroid), JSON.stringify(bboxGeo(metrics)), new Date().toISOString(), input.fieldId]
      );
    });
  }
  return getField(input.fieldId, input.userId);
}

export async function updateFieldMeta(input: { fieldId: string; userId: string; name?: string; status?: string }): Promise<FieldRow | null> {
  const existing = await getField(input.fieldId, input.userId);
  if (!existing) return null;
  const name = input.name !== undefined ? input.name : existing.name;
  const status = input.status !== undefined ? input.status : existing.status;
  await dbRun(`UPDATE fields SET name = $1, status = $2, updated_at = $3 WHERE id = $4`, [name, status, new Date().toISOString(), input.fieldId]);
  return getField(input.fieldId, input.userId);
}

export async function deleteField(fieldId: string, userId: string): Promise<boolean> {
  const res = await dbRun(`DELETE FROM fields WHERE id = $1 AND user_id = $2`, [fieldId, userId]);
  return res.changes > 0;
}

export async function listGeometryVersions(fieldId: string): Promise<any[]> {
  return dbAll(`SELECT id, field_id, version, ${GEO.toJson('geometry', 'geometry')}, created_by, created_at
    FROM field_geometry_versions WHERE field_id = $1 ORDER BY version DESC`, [fieldId]);
}

export async function countFieldsForFarm(farmId: string): Promise<number> {
  const row = (await dbGet(`SELECT COUNT(*) AS c FROM fields WHERE farm_id = $1`, [farmId])) as any;
  return Number(row?.c || 0);
}

// helpers ------------------------------------------------------------------
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

function bboxGeo(m: GeoMetrics): GeoJSON.Polygon {
  const [minX, minY, maxX, maxY] = m.bbox;
  return { type: 'Polygon', coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]] };
}
