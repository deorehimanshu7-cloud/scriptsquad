import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { SCHEMA_SQL } from "./schema";

export interface AppDb {
  conn: Database;
  /** path used ("<memory>" for in-memory) */
  location: string;
}

export function openDb(location: string): AppDb {
  if (location !== ":memory:") {
    mkdirSync(path.dirname(location), { recursive: true });
  }
  const conn = new Database(location);
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  conn.exec("PRAGMA busy_timeout = 5000;");
  migrate(conn);
  return { conn, location: location === ":memory:" ? "<memory>" : location };
}

/** Add a column to an existing table if it is missing (idempotent). */
function ensureColumn(conn: Database, table: string, column: string, ddl: string): void {
  const cols = conn.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrate(conn: Database): void {
  conn.exec(SCHEMA_SQL);
  // satellite_products was originally scene-global (UNIQUE product_id): once one
  // field stored a Sentinel scene, discovery for ANY other field under the same
  // scene skipped it as "already exists", so additional fields had permanently
  // empty catalogs. Rebuild legacy tables without the global UNIQUE; uniqueness
  // is now per (field_id, product_id) via a partial index in the schema.
  const satTbl = conn
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'satellite_products'")
    .get() as { sql: string } | null;
  if (satTbl && /product_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(satTbl.sql)) {
    conn.exec("ALTER TABLE satellite_products RENAME TO satellite_products_legacy");
    conn.exec(SCHEMA_SQL); // recreates satellite_products without the global UNIQUE
    conn.exec(
      `INSERT INTO satellite_products
        (id, user_id, farm_id, field_id, provider, satellite, product_id, collection, acquired_at, cloud_cover,
         resolution_m, processing_level, geometry, assets, platform, orbit_relative, polarization, product_type,
         preview_available, state, status, source_url, created_at)
       SELECT id, user_id, farm_id, field_id, provider, satellite, product_id, collection, acquired_at, cloud_cover,
              resolution_m, processing_level, geometry, assets, platform, orbit_relative, polarization, product_type,
              preview_available, state, status, source_url, created_at
       FROM satellite_products_legacy
       GROUP BY field_id, product_id`,
    );
    conn.exec("DROP TABLE satellite_products_legacy");
    // indexes were renamed onto the legacy table; (re)create on the new table
    conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sat_field_product ON satellite_products(field_id, product_id)");
    conn.exec("CREATE INDEX IF NOT EXISTS idx_sat_field_time ON satellite_products(field_id, acquired_at)");
  }
  // forward migrations for databases created before these columns existed
  ensureColumn(conn, "satellite_products", "platform", "platform TEXT");
  ensureColumn(conn, "satellite_products", "orbit_relative", "orbit_relative INTEGER");
  ensureColumn(conn, "satellite_products", "polarization", "polarization TEXT");
  ensureColumn(conn, "satellite_products", "product_type", "product_type TEXT");
  // physical devices: stable external id used by firmware/MQTT (e.g. AGRIFUR-ESP32-001)
  ensureColumn(conn, "devices", "external_id", "external_id TEXT");
  conn.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_external ON devices(external_id) WHERE external_id IS NOT NULL");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function tsAddHours(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
}

export function hoursAgoIso(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}
