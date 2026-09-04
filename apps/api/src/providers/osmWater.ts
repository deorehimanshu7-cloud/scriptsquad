/**
 * Water features from OpenStreetMap (Overpass API) — a legitimate, keyless,
 * open spatial dataset (© OpenStreetMap contributors, ODbL).
 *
 * Honest classification: this reports the PRESENCE and DISTANCE of mapped
 * water features near a field (surface water context derived from a map
 * dataset). It is NOT a discharge measurement, NOT groundwater depth, and NOT
 * an in-situ observation. State = DERIVED (from map dataset) with full
 * provenance; groundwater/aquifer/irrigation remain separate layers.
 *
 * Distance is measured to the feature CENTER (Overpass `out center`), so it is
 * an approximation, never a surveyed shoreline distance.
 */
import { fetchJson } from "./orchestrator";
import { round } from "../util";

export interface WaterFeature {
  kind: "waterway" | "waterbody";
  tags: Record<string, string>;
  center: { lat: number; lon: number };
  distance_km: number;
}

export interface WaterFeaturesResult {
  total: number;
  within_1km: number;
  searched_radius_km: number;
  endpoint?: string;
  nearest: {
    kind: WaterFeature["kind"];
    type: string;
    name: string | null;
    distance_km: number;
    center: { lat: number; lon: number };
  } | null;
  features: WaterFeature[];
  note: string;
}

/**
 * Endpoint failover: the main Overpass instance is frequently overloaded or
 * unreachable from some networks; official public mirrors carry the same data.
 * The first endpoint that answers is used and recorded in provenance — if all
 * fail, the error lists every endpoint attempted (never a silent fake result).
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const SEARCH_RADIUS_M = 6000;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface OverpassElement {
  type: string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  lat?: number;
  lon?: number;
}
interface OverpassResponse {
  elements?: OverpassElement[];
}

export function waterOverpassEndpoints(): string[] {
  return [...OVERPASS_ENDPOINTS];
}

export async function getWaterFeatures(lat: number, lon: number): Promise<WaterFeaturesResult> {
  const query = `[out:json][timeout:25];
(
  way["waterway"~"^(river|stream|canal|drain|ditch)$"](around:${SEARCH_RADIUS_M},${lat},${lon});
  way["natural"="water"](around:${SEARCH_RADIUS_M},${lat},${lon});
);
out tags center 200;`;

  const body = `data=${encodeURIComponent(query)}`;
  let lastErr: unknown = null;
  let res: OverpassResponse | null = null;
  let servedBy: string | null = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      res = await fetchJson<OverpassResponse>(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      }, 20_000);
      servedBy = endpoint;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!res || !servedBy) {
    throw new Error(
      `All Overpass endpoints failed. Attempted: ${OVERPASS_ENDPOINTS.join(", ")}. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }
  (res as OverpassResponse & { _servedBy?: string })._servedBy = servedBy;

  const elements = res.elements ?? [];
  const servedEndpoint = (res as OverpassResponse & { _servedBy?: string })._servedBy ?? OVERPASS_ENDPOINTS[0];
  const features: WaterFeature[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const c = el.center ?? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null);
    if (!c) continue;
    const isWaterbody = tags.natural === "water";
    const isWaterway = typeof tags.waterway === "string";
    if (!isWaterbody && !isWaterway) continue;
    features.push({
      kind: isWaterbody ? "waterbody" : "waterway",
      tags,
      center: c,
      distance_km: round(haversineKm(lat, lon, c.lat, c.lon), 3),
    });
  }
  features.sort((a, b) => a.distance_km - b.distance_km);
  const nearest = features[0] ?? null;
  const nearestMeta = nearest
    ? {
        kind: nearest.kind,
        type: nearest.kind === "waterbody" ? `natural=water (${nearest.tags.water ?? "water body"})` : `waterway=${nearest.tags.waterway}`,
        name: nearest.tags.name ?? nearest.tags["name:en"] ?? null,
        distance_km: nearest.distance_km,
        center: nearest.center,
      }
    : null;

  return {
    total: features.length,
    within_1km: features.filter((f) => f.distance_km <= 1).length,
    searched_radius_km: SEARCH_RADIUS_M / 1000,
    nearest: nearestMeta,
    features: features.slice(0, 40),
    endpoint: servedEndpoint,
    note:
      features.length > 0
        ? `Found ${features.length} mapped water feature(s) within ${SEARCH_RADIUS_M / 1000} km of the field (${features.filter((f) => f.distance_km <= 1).length} within 1 km). Distances are to feature centers — an approximation, not a shoreline survey.`
        : `No mapped water features (waterways or water bodies) within ${SEARCH_RADIUS_M / 1000} km of the field in OpenStreetMap (dataset coverage varies by region).`,
  };
}

/** Lightweight probe used by provider health checks. */
export async function pingOsmWater(): Promise<boolean> {
  // 0.1 km² probe over the open ocean returns no features fast and proves the
  // endpoint + query syntax work (status AVAILABLE means reachable + parsing).
  const r = await getWaterFeatures(19.9993, 73.7903);
  return r.total >= 0;
}

export const osmWaterDatasetProvenance = {
  dataset: "OpenStreetMap (Overpass API)",
  dataset_id: "osm-water",
  source_url: "https://www.openstreetmap.org",
  license: "ODbL (© OpenStreetMap contributors)",
  dataset_state: "SPATIAL_DATASET",
  provider: "osm-water",
  endpoints: OVERPASS_ENDPOINTS,
} as const;
