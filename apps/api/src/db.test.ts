import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "./db";

/**
 * Regression: databases created before the MQTT work have a `devices` table
 * without `external_id`. SCHEMA_SQL used to build idx_devices_external on that
 * column before migrate() could add it, so any legacy database crashed the API
 * at boot with "no such column: external_id". openDb must migrate instead.
 */
describe("database migrations (legacy databases)", () => {
  test("openDb adds external_id + index to a pre-MQTT devices table instead of crashing", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agrifur-db-"));
    const file = path.join(dir, "legacy.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      farm_id TEXT NOT NULL,
      field_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'sensor_node',
      firmware_version TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      last_seen_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    legacy.close();

    const db = openDb(file); // must not throw
    const cols = db.conn.query("PRAGMA table_info(devices)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain("external_id");
    const idx = db.conn.query("PRAGMA index_list(devices)").all() as { name: string }[];
    expect(idx.some((i) => i.name === "idx_devices_external")).toBe(true);
    db.conn.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("openDb rebuilds a scene-global satellite_products table so two fields can store the same Sentinel product", () => {
    // Pre-fix databases declared `product_id TEXT NOT NULL UNIQUE`, which made
    // satellite products global: once one field stored a scene, discovery for
    // any other field under the same scene skipped it (empty catalogs).
    const dir = mkdtempSync(path.join(tmpdir(), "agrifur-sat-"));
    const file = path.join(dir, "legacy.db");
    const legacy = new Database(file);
    legacy.exec(`CREATE TABLE satellite_products (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      farm_id TEXT NOT NULL,
      field_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      satellite TEXT NOT NULL,
      product_id TEXT NOT NULL UNIQUE,
      collection TEXT,
      acquired_at TEXT NOT NULL,
      cloud_cover REAL,
      resolution_m REAL,
      processing_level TEXT,
      geometry TEXT,
      assets TEXT,
      platform TEXT,
      orbit_relative INTEGER,
      polarization TEXT,
      product_type TEXT,
      preview_available INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'OBSERVED',
      status TEXT NOT NULL DEFAULT 'discovered',
      source_url TEXT,
      created_at TEXT NOT NULL
    )`);
    legacy.exec(`INSERT INTO satellite_products
      (id, user_id, farm_id, field_id, provider, satellite, product_id, acquired_at, created_at)
      VALUES ('sat_a1', 'u', 'f1', 'field_1', 'copernicus', 'Sentinel-2', 'S2A_T43QCC_SCENE', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')`);
    legacy.close();

    const db = openDb(file); // migration must rebuild without the global UNIQUE
    const tbl = db.conn.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='satellite_products'").get() as { sql: string };
    expect(tbl.sql).not.toMatch(/product_id TEXT NOT NULL UNIQUE/i);
    // legacy row preserved, then the SAME scene may be stored for a second field
    db.conn
      .query(
        `INSERT INTO satellite_products
         (id, user_id, farm_id, field_id, provider, satellite, product_id, acquired_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run("sat_a2", "u", "f1", "field_2", "copernicus", "Sentinel-2", "S2A_T43QCC_SCENE", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    const both = db.conn.query("SELECT COUNT(*) AS n FROM satellite_products WHERE product_id = 'S2A_T43QCC_SCENE'").get() as { n: number };
    expect(both.n).toBe(2); // one per field — no global uniqueness
    db.conn.close();
    rmSync(dir, { recursive: true, force: true });
  });
});