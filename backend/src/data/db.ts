/**
 * AGRIFUR2 data-access driver.
 *
 * Two modes, one contract:
 *  - postgres   : PostgreSQL + PostGIS (CANONICAL / PRODUCTION). All spatial
 *                 calculations use PostGIS (ST_Area/ST_Perimeter/ST_Centroid/
 *                 ST_IsValid/ST_Intersects/...). Geometry columns are written
 *                 from GeoJSON with ST_GeomFromGeoJSON and read back through
 *                 ST_AsGeoJSON.
 *  - sqlite-dev : SQLite development fallback (DATABASE_MODE=sqlite-dev),
 *                 explicitly labelled and never claimed as PostGIS-backed.
 *                 Geometry is stored as GeoJSON text; metrics are computed by
 *                 the shared geodesic utilities and flagged computed_by:
 *                 "sqlite-dev-geo".
 *
 * Repository SQL is written with '$1' placeholders; the sqlite driver
 * translates them to '?'.
 */

export type DbMode = 'postgres' | 'sqlite-dev';

export function dbMode(): DbMode {
  const m = (process.env.DATABASE_MODE || 'postgres').toLowerCase();
  if (m === 'postgres' || m === 'sqlite-dev') return m;
  throw new Error(`Invalid DATABASE_MODE "${m}". Use "postgres" (production, PostGIS) or "sqlite-dev" (development fallback).`);
}

export function isPostgres(): boolean {
  return dbMode() === 'postgres';
}

export function modeLabel(): string {
  return dbMode();
}

function toSqliteSql(sql: string): string {
  return sql.replace(/\$\d+/g, '?');
}

async function poolOrThrow() {
  const { getPool } = await import('../database/connection');
  return getPool();
}

/**
 * Translate runtime values for the active mode: objects → JSON strings for
 * sqlite JSONB-mirror columns; Date → ISO strings for pg.
 */
function normalizeParams(params: any[]): any[] {
  return params.map((p) => {
    if (p instanceof Date) return p.toISOString();
    // sqlite stores JSONB-mirror columns as TEXT; pg accepts a JSON string for
    // a jsonb column too — one representation for both modes.
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

export interface DbRow extends Record<string, any> {}

/** Run a query returning many rows. */
export async function dbAll(sql: string, params: any[] = []): Promise<DbRow[]> {
  const mode = dbMode();
  const p = normalizeParams(params);
  if (mode === 'sqlite-dev') {
    const { getDb } = await import('../database/sqlite');
    const db = getDb();
    return db.prepare(toSqliteSql(sql)).all(...p).map((r: any) => normalizeSqliteRow(r)) as DbRow[];
  }
  const pool = await poolOrThrow();
  const res = await pool.query(sql, p);
  return (res.rows || []).map(serializePgRow);
}

/** Run a query returning a single row (first). */
export async function dbGet(sql: string, params: any[] = []): Promise<DbRow | null> {
  const mode = dbMode();
  const p = normalizeParams(params);
  if (mode === 'sqlite-dev') {
    const { getDb } = await import('../database/sqlite');
    const db = getDb();
    const row = db.prepare(toSqliteSql(sql)).get(...p) as Record<string, any> | undefined;
    return row ? normalizeSqliteRow(row) : null;
  }
  const pool = await poolOrThrow();
  const res = await pool.query(sql, p);
  const row = res.rows?.[0];
  return row ? serializePgRow(row) : null;
}

/** Run a write query. Returns affected row count. */
export async function dbRun(sql: string, params: any[] = []): Promise<{ changes: number }> {
  const mode = dbMode();
  const p = normalizeParams(params);
  if (mode === 'sqlite-dev') {
    const { getDb } = await import('../database/sqlite');
    const db = getDb();
    const info = db.prepare(toSqliteSql(sql)).run(...p);
    return { changes: info.changes };
  }
  const pool = await poolOrThrow();
  const res = await pool.query(sql, p);
  return { changes: res.rowCount ?? 0 };
}

// sqlite-dev transactions are serialized through an in-process promise queue:
// better-sqlite3 transactions are synchronous, so async work is wrapped in
// explicit BEGIN/COMMIT/ROLLBACK and never interleaved with other writers.
let sqliteTxQueue: Promise<unknown> = Promise.resolve();

async function sqliteTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const run = sqliteTxQueue.then(async () => {
    const { getDb } = await import('../database/sqlite');
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection already broken */ }
      throw err;
    }
  });
  sqliteTxQueue = run.then(() => undefined, () => undefined);
  return run;
}

/** Execute work inside a transaction. */
export async function dbTx<T>(fn: () => Promise<T>): Promise<T> {
  const mode = dbMode();
  if (mode === 'sqlite-dev') return sqliteTransaction(fn);
  const { transaction } = await import('../database/connection');
  return transaction(async () => fn());
}

/** sqlite-dev: JSONB-mirror columns are TEXT — parse values that look like JSON. */
function normalizeSqliteRow(row: Record<string, any>): DbRow {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && v.length > 1 && ((v[0] === '{' && v[v.length - 1] === '}') || (v[0] === '[' && v[v.length - 1] === ']'))) {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Serialize pg rows: Dates → ISO; Buffer → utf8 (legacy geometry select). */
function serializePgRow(row: any): DbRow {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
    else if (typeof v === 'object' && v !== null && (v as any).type === 'Polygon') out[k] = v; // jsonb geometry geojson passthrough
    else out[k] = v;
  }
  return out;
}

/** Health probe: verifies the live mode and, in postgres mode, PostGIS. */
export async function dbHealth(): Promise<{
  mode: DbMode;
  ok: boolean;
  postgis: boolean;
  detail: string;
  postgis_version?: string;
}> {
  const mode = dbMode();
  try {
    if (mode === 'sqlite-dev') {
      const { getDb } = await import('../database/sqlite');
      getDb();
      return { mode, ok: true, postgis: false, detail: 'SQLite development database (sqlite-dev). Geometry metrics are computed by shared geodesic utilities, NOT by PostGIS.' };
    }
    const pool = await poolOrThrow();
    await pool.query('SELECT 1');
    const pg = await pool.query('SELECT postgis_version() AS v');
    const version = pg.rows?.[0]?.v as string | undefined;
    return { mode, ok: true, postgis: !!version, detail: version ? `PostgreSQL + PostGIS ${version}` : 'PostgreSQL reachable but PostGIS extension missing', postgis_version: version };
  } catch (e: any) {
    return { mode, ok: false, postgis: false, detail: `Database unavailable: ${e.message}` };
  }
}

// Geometry helpers used by repository SQL builders -------------------------
export const GEO = {
  /** Insert expression: cast GeoJSON param to SRID 4326 geometry. */
  fromJson(col: string): string {
    return isPostgres() ? `ST_SetSRID(ST_GeomFromGeoJSON(${col}), 4326)` : `${col}`;
  },
  /** Select expression returning GeoJSON text for a geometry column. */
  toJson(col: string, alias = col): string {
    return isPostgres() ? `ST_AsGeoJSON(${col}) AS ${alias}` : `${col} AS ${alias}`;
  },
  /** Geodesic area m². PostGIS: ST_Area on geography (geodesic). */
  areaM2Expr(col: string): string {
    return isPostgres() ? `ST_Area(${col}::geography)` : col; // sqlite: unused (computed in JS)
  },
};
