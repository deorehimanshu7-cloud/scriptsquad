import { config } from "../config";
import { fetchJson } from "./orchestrator";

export interface StacAssetSummary {
  key: string;
  title: string | null;
  type: string | null;
  credential_gated: boolean; // raster access on Data Space requires OAuth token
}

export interface StacProduct {
  satellite: string;
  product_id: string;
  collection: string;
  acquired_at: string;
  cloud_cover: number | null;
  resolution_m: number | null;
  processing_level: string | null;
  platform: string | null;
  orbit_relative: number | null;
  polarization: string | null;
  product_type: string | null;
  geometry: unknown;
  assets: StacAssetSummary[];
  source_url: string;
}

export const COLLECTIONS: Record<string, { satellite: string; label: string; modality: "optical" | "sar" }> = {
  "sentinel-2-l2a": { satellite: "Sentinel-2 (L2A)", label: "Sentinel-2 L2A surface reflectance", modality: "optical" },
  "sentinel-2-l1c": { satellite: "Sentinel-2 (L1C)", label: "Sentinel-2 L1C top-of-atmosphere", modality: "optical" },
  "sentinel-1-grd": { satellite: "Sentinel-1 (GRD)", label: "Sentinel-1 SAR GRD", modality: "sar" },
  "landsat-c2-l2": { satellite: "Landsat 8/9", label: "Landsat Collection 2 Level-2", modality: "optical" },
};

/** Collections searched by the scheduled discovery (optical + SAR + Landsat). */
export const DEFAULT_DISCOVERY_COLLECTIONS = ["sentinel-2-l2a", "sentinel-1-grd"] as const;
// Note: Landsat is NOT hosted on Copernicus Data Space STAC (all landsat-*
// collection ids return 404 → including one 400s the entire search). Landsat
// would need a USGS/other provider with its own AUTH_REQUIRED adapter; we never
// fake Landsat products here.

/** Optical collections (eo:cloud_cover exists here; SAR items have no cloud property). */
export const OPTICAL_COLLECTIONS = new Set(["sentinel-2-l2a", "sentinel-2-l1c"]);

export async function pingCopernicus(): Promise<string> {
  const d = await fetchJson<{ collections?: unknown[] }>(`${config.copernicusStacUrl}/collections?limit=1`, undefined, 12_000);
  return d.collections ? `ok (${d.collections.length} sample)` : "ok";
}

/**
 * STAC search over a field AOI. Anonymous discovery of product metadata works;
 * asset/raster access needs Copernicus OAuth credentials → each asset is
 * flagged credential_gated: true until credentials are configured.
 */
export async function searchStac(opts: {
  bbox: [number, number, number, number];
  from: string; // ISO date
  to: string;
  collectionKeys?: string[];
  maxCloud?: number;
  limit?: number;
}): Promise<StacProduct[]> {
  const collectionKeys = opts.collectionKeys ?? ["sentinel-2-l2a"];
  const body: Record<string, unknown> = {
    collections: collectionKeys,
    bbox: opts.bbox,
    datetime: `${opts.from}/${opts.to}`,
    limit: opts.limit ?? 10,
  };
  // eo:cloud_cover only exists on optical items — applying the query to a SAR
  // collection would silently drop every SAR product.
  const allOptical = collectionKeys.every((c) => OPTICAL_COLLECTIONS.has(c));
  if (opts.maxCloud !== undefined && opts.maxCloud > 0 && allOptical) {
    body.query = { "eo:cloud_cover": { lt: opts.maxCloud } };
  }
  const res = await fetchJson<{ features?: unknown[] }>(`${config.copernicusStacUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const features = res.features ?? [];
  const products: StacProduct[] = [];
  for (const f of features) {
    const item = f as Record<string, unknown>;
    const props = (item.properties ?? {}) as Record<string, unknown>;
    const assets = (item.assets ?? {}) as Record<string, { title?: string; type?: string }>;
    const collection = String(item.collection ?? "unknown");
    const meta = COLLECTIONS[collection] ?? { satellite: String(props.platform ?? collection), label: collection, modality: "optical" };
    const assetSummaries: StacAssetSummary[] = Object.entries(assets).map(([key, a]) => ({
      key,
      title: a.title ?? null,
      type: a.type ?? null,
      credential_gated: true, // Data Space asset endpoints require OAuth
    }));
    products.push({
      satellite: meta.satellite,
      product_id: String(item.id),
      collection,
      acquired_at: String(props.datetime ?? ""),
      cloud_cover: typeof props["eo:cloud_cover"] === "number" ? (props["eo:cloud_cover"] as number) : null,
      resolution_m: typeof props["gsd"] === "number" ? (props["gsd"] as number) : null,
      processing_level: typeof props["processing:level"] === "string" ? (props["processing:level"] as string) : null,
      platform: typeof props["platform"] === "string" ? (props["platform"] as string) : null,
      orbit_relative: typeof props["sat:relative_orbit"] === "number" ? (props["sat:relative_orbit"] as number) : null,
      polarization: Array.isArray(props["sar:polarizations"]) ? (props["sar:polarizations"] as string[]).join("/") : null,
      product_type:
        typeof props["s2:product_type"] === "string"
          ? (props["s2:product_type"] as string)
          : typeof props["s1:product_type"] === "string"
            ? (props["s1:product_type"] as string)
            : null,
      geometry: item.geometry ?? null,
      assets: assetSummaries.slice(0, 12),
      source_url: String(
        (item.self as string | undefined) ??
          (item.links as { rel: string; href: string }[] | undefined)?.find?.((l) => l.rel === "self")?.href ??
          "",
      ),
    });
  }
  // newest first by acquisition
  products.sort((a, b) => (a.acquired_at < b.acquired_at ? 1 : -1));
  return products;
}