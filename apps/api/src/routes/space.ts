import { Router } from "express";
import type { Request } from "express";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { getOwnedField, requireAuth } from "../http";
import { refreshSatellite } from "../services/pipeline";
import { addEvidence } from "../services/evidence";
import { runProvider } from "../providers/orchestrator";
import { DEFAULT_DISCOVERY_COLLECTIONS, searchStac } from "../providers/copernicus";
import { aoiBbox, fieldIntersectionPct } from "../geo";

const ALLOWED_COLLECTIONS = new Set([
  "sentinel-2-l2a",
  "sentinel-2-l1c",
  "sentinel-1-grd",
  // Landsat is deliberately NOT allowed: landsat-* collection ids do not exist
  // on Copernicus Data Space STAC, and including one 400s the entire search.
  // Landsat would need a separate USGS adapter (AUTH_REQUIRED) — never faked.
]);

interface ProductRow {
  id: string;
  provider: string;
  satellite: string;
  product_id: string;
  collection: string | null;
  acquired_at: string;
  cloud_cover: number | null;
  resolution_m: number | null;
  processing_level: string | null;
  platform: string | null;
  orbit_relative: number | null;
  polarization: string | null;
  product_type: string | null;
  geometry: string | null;
  assets: string | null;
  preview_available: number;
  state: string;
  status: string;
  source_url: string | null;
  created_at: string;
}

function fieldGeometry(db: AppDb, fieldId: string): unknown {
  const row = db.conn.query("SELECT geometry FROM fields WHERE id = ?").get(fieldId) as { geometry: string } | undefined;
  return row ? JSON.parse(row.geometry) : null;
}

function mapProduct(row: ProductRow, fieldGeometry: unknown): Record<string, unknown> {
  const geometry = row.geometry ? (JSON.parse(row.geometry) as unknown) : null;
  return {
    ...row,
    assets: row.assets ? JSON.parse(row.assets) : [],
    geometry,
    field_intersection_pct: fieldIntersectionPct(fieldGeometry as never, geometry),
  };
}

function listProducts(db: AppDb, fieldId: string): ProductRow[] {
  return db.conn
    .query(
      `SELECT id, provider, satellite, product_id, collection, acquired_at, cloud_cover, resolution_m, processing_level,
              platform, orbit_relative, polarization, product_type, geometry, assets, preview_available, state, status, source_url, created_at
       FROM satellite_products WHERE field_id = ? ORDER BY acquired_at DESC LIMIT 300`,
    )
    .all(fieldId) as unknown as ProductRow[];
}

export function spaceRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  // All discovered products for a field, newest first, with estimated field intersection
  r.get("/fields/:id/satellite/products", (req, res) => {
    const f = fld(req);
    const geom = fieldGeometry(db, f.id);
    const products = listProducts(db, f.id).map((p) => mapProduct(p, geom));
    res.json({ products });
  });

  // Summary: latest acquisition, best qualified, counts by collection, provider state
  r.get("/fields/:id/satellite/summary", (req, res) => {
    const f = fld(req);
    const counts = db.conn
      .query("SELECT collection, COUNT(*) as n FROM satellite_products WHERE field_id = ? GROUP BY collection")
      .all(f.id) as { collection: string; n: number }[];
    const latest = db.conn
      .query("SELECT * FROM satellite_products WHERE field_id = ? ORDER BY acquired_at DESC LIMIT 1")
      .get(f.id) as ProductRow | undefined;
    const best = db.conn
      .query(
        "SELECT * FROM satellite_products WHERE field_id = ? AND cloud_cover IS NOT NULL ORDER BY cloud_cover ASC, acquired_at DESC LIMIT 1",
      )
      .get(f.id) as ProductRow | undefined;
    const provider = db.conn.query("SELECT * FROM provider_health WHERE provider = 'copernicus'").get() as Record<string, unknown> | undefined;
    const sar = db.conn.query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ? AND collection LIKE 'sentinel-1%'").get(f.id) as { n: number };
    const optical = db.conn
      .query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ? AND collection NOT LIKE 'sentinel-1%'")
      .get(f.id) as { n: number };
    const geom = fieldGeometry(db, f.id);
    res.json({
      summary: {
        total: counts.reduce((a, c) => a + c.n, 0),
        collections: counts,
        optical,
        sar,
        latest_acquisition: latest ? mapProduct(latest, geom) : null,
        best_qualified: best ? mapProduct(best, geom) : null,
        provider_status: provider ?? { provider: "copernicus", status: "NOT_CONFIGURED", auth_state: "required" },
        note: "Discovery metadata is real STAC data (Sentinel-2 optical, Sentinel-1 SAR). Raster/preview access requires Copernicus OAuth credentials (AUTH_REQUIRED until configured). Landsat is NOT available from this endpoint — a separate USGS adapter (credential-gated) would be required and is not configured.",
      },
    });
  });

  // Live catalog search with a user-chosen date range + collection/cloud filters.
  // Runs the same STAC path as scheduled discovery, persists new products.
  r.post("/fields/:id/satellite/search", async (req, res, next) => {
    try {
      const f = fld(req);
      const geom = fieldGeometry(db, f.id);
      const from = typeof req.body?.from === "string" ? req.body.from : null;
      const to = typeof req.body?.to === "string" ? req.body.to : null;
      if (!from || !to) {
        res.status(400).json({ error: { code: "BAD_REQUEST", message: "from and to (ISO date or datetime) are required" } });
        return;
      }
      const requested = Array.isArray(req.body?.collections) && req.body.collections.length > 0 ? req.body.collections : [...DEFAULT_DISCOVERY_COLLECTIONS];
      const collections = (requested as string[]).filter((c) => ALLOWED_COLLECTIONS.has(c));
      if (collections.length === 0) {
        res.status(400).json({ error: { code: "BAD_REQUEST", message: "no supported collections requested" } });
        return;
      }
      const maxCloud = typeof req.body?.max_cloud === "number" ? req.body.max_cloud : undefined;
      const limit = typeof req.body?.limit === "number" ? Math.min(Number(req.body.limit), 80) : 40;

      const result = await runProvider(
        { db },
        "copernicus",
        () =>
          searchStac({ bbox: aoiBbox(geom as never), from, to, collectionKeys: collections, maxCloud, limit }).then((data) => ({
            data,
          })),
        { timeoutMs: 40_000, retries: 1 },
      );
      if (result.status !== "AVAILABLE" || !result.data) {
        res.status(502).json({
          error: { code: "PROVIDER_ERROR", message: `Copernicus STAC search failed: ${result.status} ${result.error ?? ""}` },
        });
        return;
      }
      let added = 0;
      const byCollection = new Map<string, number>();
      for (const p of result.data) {
        // per-field dedupe: the same Sentinel scene covers multiple fields and
        // must be stored per field so each catalog stays field-isolated
        const existing = db.conn.query("SELECT id FROM satellite_products WHERE field_id = ? AND product_id = ?").get(f.id, p.product_id);
        if (existing) continue;
        db.conn
          .query(
            `INSERT INTO satellite_products
             (id, user_id, farm_id, field_id, provider, satellite, product_id, collection, acquired_at, cloud_cover, resolution_m, processing_level,
              geometry, assets, platform, orbit_relative, polarization, product_type, preview_available, state, status, source_url, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'OBSERVED','discovered',?,?)`,
          )
        .run(
          `sat_${p.product_id.slice(0, 32)}_${f.id.slice(-8)}`,
          f.user_id,
            f.farm_id,
            f.id,
            "copernicus",
            p.satellite,
            p.product_id,
            p.collection,
            p.acquired_at,
            p.cloud_cover,
            p.resolution_m,
            p.processing_level,
            p.geometry ? JSON.stringify(p.geometry) : null,
            JSON.stringify(p.assets),
            p.platform,
            p.orbit_relative,
            p.polarization,
            p.product_type,
            p.source_url,
            nowIso(),
          );
        added++;
        byCollection.set(p.collection, (byCollection.get(p.collection) ?? 0) + 1);
      }
      const total = (db.conn.query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ?").get(f.id) as { n: number }).n;
      res.json({
        ok: true,
        searched: { from, to, collections, max_cloud: maxCloud ?? null },
        added,
        by_collection: Object.fromEntries(byCollection),
        total,
      });
    } catch (e) {
      next(e);
    }
  });

  // Single product detail (with estimated field intersection)
  r.get("/fields/:id/satellite/products/:pid", (req, res) => {
    const f = fld(req);
    const row = db.conn
      .query("SELECT * FROM satellite_products WHERE field_id = ? AND id = ?")
      .get(f.id, String(req.params.pid)) as ProductRow | undefined;
    if (!row) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "product not found" } });
      return;
    }
    res.json({ product: mapProduct(row, fieldGeometry(db, f.id)) });
  });

  // Promote a real acquisition into the evidence layer (deduplicated per product)
  r.post("/fields/:id/satellite/products/:pid/evidence", (req, res) => {
    const f = fld(req);
    const row = db.conn
      .query("SELECT * FROM satellite_products WHERE field_id = ? AND id = ?")
      .get(f.id, String(req.params.pid)) as ProductRow | undefined;
    if (!row) {
      res.status(404).json({ error: { code: "NOT_FOUND", message: "product not found" } });
      return;
    }
    const subType = `acquisition:${row.product_id}`;
    const dup = db.conn.query("SELECT id FROM evidence WHERE field_id = ? AND domain = 'satellite' AND sub_type = ?").get(f.id, subType);
    if (dup) {
      res.json({ ok: true, already_added: true, evidence_id: String((dup as { id: string }).id) });
      return;
    }
    const ev = addEvidence(db, {
      userId: f.user_id,
      farmId: f.farm_id,
      fieldId: f.id,
      domain: "satellite",
      source: "Copernicus CDSE (STAC)",
      source_type: row.collection ?? "stac",
      sub_type: subType,
      measurement: `${row.satellite} acquisition`,
      value: row.cloud_cover,
      unit: row.cloud_cover !== null ? "%" : null,
      state: "OBSERVED",
      observed_at: row.acquired_at,
      geometry: row.geometry ? JSON.parse(row.geometry) : null,
      description: `Real ${row.satellite} acquisition (${row.collection ?? "collection unknown"})${row.cloud_cover !== null ? `, cloud cover ${row.cloud_cover}%` : ""}${row.platform ? `, platform ${row.platform}` : ""}${row.polarization ? `, polarization ${row.polarization}` : ""}. Metadata from Copernicus Data Space STAC; raster access AUTH_REQUIRED.`,
      provenance: {
        provider: "copernicus",
        model: row.satellite,
        model_version: row.collection ?? undefined,
        processing: "STAC catalog discovery over field AOI",
        access_url: row.source_url ?? undefined,
        credential_gated: true,
      },
    });
    res.json({ ok: true, already_added: false, evidence_id: ev.id });
  });

  // Time series from real acquisition metadata (cloud cover over time).
  // Index values (NDVI etc.) are NOT fabricated — see /indices.
  r.get("/fields/:id/satellite/timeseries", (req, res) => {
    const f = fld(req);
    const rows = db.conn
      .query(
        "SELECT product_id, satellite, collection, acquired_at, cloud_cover, resolution_m FROM satellite_products WHERE field_id = ? AND cloud_cover IS NOT NULL ORDER BY acquired_at ASC",
      )
      .all(f.id) as { product_id: string; satellite: string; collection: string; acquired_at: string; cloud_cover: number; resolution_m: number | null }[];
    const points = rows.map((r) => ({
      date: r.acquired_at,
      cloud_cover: r.cloud_cover,
      resolution_m: r.resolution_m,
      satellite: r.satellite,
      collection: r.collection,
      product_id: r.product_id,
    }));
    res.json({
      points,
      insufficient: points.length < 2,
      note:
        points.length < 2
          ? "INSUFFICIENT OBSERVATIONS — cloud-cover trend needs at least two acquisitions (no fabricated trend)."
          : "Cloud cover over actual acquisition dates (metadata-derived, OBSERVED acquisitions).",
      indices_note: "Vegetation indices (NDVI/NDRE/SAVI) require raster access — AUTH_REQUIRED until Copernicus OAuth credentials are configured.",
    });
  });

  // Honest index endpoint: indices need raster pixels, which are credential-gated.
  r.get("/fields/:id/satellite/indices", (req, res) => {
    const f = fld(req);
    const n = (db.conn.query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ?").get(f.id) as { n: number }).n;
    res.json({
      indices: [],
      status: "AUTH_REQUIRED",
      reason:
        "Vegetation indices (NDVI, NDRE, SAVI, NDWI) are computed from band rasters. Copernicus Data Space raster assets require OAuth credentials; until configured, no index value is fabricated. Metadata-only products are still listed in the catalog.",
      products_available: n,
    });
  });

  // Trigger a discovery run now (scheduled path — multi-collection)
  r.post("/fields/:id/satellite/discover", async (req, res, next) => {
    try {
      const f = fld(req);
      await refreshSatellite(db, f.id);
      const rows = db.conn
        .query("SELECT COUNT(*) as n FROM satellite_products WHERE field_id = ?")
        .get(f.id) as { n: number };
      res.json({ ok: true, total_products: rows.n });
    } catch (e) {
      next(e);
    }
  });

  return r;
}