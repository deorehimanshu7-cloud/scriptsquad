/**
 * Real DEM terrain provider — keyless open elevation data.
 *
 * Uses the OpenTopoData public API (https://www.opentopodata.org) which serves
 * NASA SRTM 90 m and ASTER GDEM 30 m rasters (plus others). This is REAL DEM
 * data: each returned value is sampled from the actual global raster at the
 * requested coordinate.
 *
 * Truth labels:
 *  - sample elevations      → DERIVED (raster cell values sampled at a point;
 *                             they are model/remote-sensing products, not field
 *                             survey measurements)
 *  - min/max/mean/range     → DERIVED (statistics over the real samples)
 *  - slope / aspect         → DERIVED (finite-difference gradient computed from
 *                             the real DEM samples; method is recorded)
 *
 * Provider hierarchy (documented in the world model):
 *   1. SRTM 90 m (NASA, via OpenTopoData)
 *   2. ASTER GDEM 30 m (METI/NASA, via OpenTopoData) — automatic fallback
 *   3. Open-Meteo centroid elevation — last-resort point fallback (caller)
 */
import type { ProviderId } from "contracts";
import { config } from "../config";

export interface DemSample {
  lat: number;
  lon: number;
  elevation_m: number;
  /** null when the dataset has no value for this cell */
  elevation_m_raw: number | null;
}

export interface DemResult {
  dataset: "srtm90m" | "aster30m";
  samples: DemSample[];
  endpoint: string;
}

export const opentopodataProvenance = {
  provider: "opentopodata" as ProviderId,
  dataset_name: "OpenTopoData elevation service",
  sources: ["NASA SRTM v4.1 90m", "ASTER GDEM v3 30m"],
  license: "SRTM: public domain (NASA). ASTER GDEM: free redistribution with attribution (METI/NASA). Service terms at opentopodata.org.",
  dataset_state: "HISTORICAL_DATASET",
  coverage: "Global, 90 m (SRTM) / 30 m (ASTER) raster cells",
  resolution: "90 m (srtm90m) / 30 m (aster30m)",
  download_date: null as string | null,
  note: "Values are DEM raster samples at point coordinates — DERIVED elevation, never field survey measurements.",
};

export const OPENTOPODATA_ENDPOINTS = [
  `${config.openTopoDataBaseUrl}/v1/srtm90m`,
  `${config.openTopoDataBaseUrl}/v1/aster30m`,
];

/**
 * Sample the DEM at the given coordinates. Tries each dataset in order
 * (SRTM 90m → ASTER 30m) so a missing SRTM tile falls back to ASTER
 * automatically. Up to 100 locations per request (API limit).
 */
export async function getDemSamples(locations: { lat: number; lon: number }[]): Promise<DemResult> {
  if (locations.length === 0) throw new Error("getDemSamples: no locations");
  const locStr = locations.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join("|");

  let lastErr: unknown = null;
  for (const endpoint of OPENTOPODATA_ENDPOINTS) {
    const dataset = endpoint.includes("aster30m") ? "aster30m" : "srtm90m";
    try {
      const raw = await fetchJson<{
        status?: string;
        results?: { dataset: string; elevation: number | null; location: { lat: number; lng: number } }[];
        error?: string;
      }>(`${endpoint}?locations=${encodeURIComponent(locStr)}`, undefined, 20_000);
      if (raw.status !== "OK" || !Array.isArray(raw.results)) {
        throw new Error(`DEM query failed: ${raw.error ?? raw.status ?? "unknown"}`);
      }
      const samples: DemSample[] = raw.results.map((r) => ({
        lat: r.location.lat,
        lon: r.location.lng,
        elevation_m_raw: r.elevation,
        elevation_m: typeof r.elevation === "number" && Number.isFinite(r.elevation) ? r.elevation : 0,
      }));
      return { dataset, samples, endpoint };
    } catch (err) {
      lastErr = err;
      // try next dataset
    }
  }
  throw new Error(`DEM datasets unavailable (SRTM 90m, ASTER 30m): ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** Lightweight health probe for the provider registry. */
export async function pingOpenTopoData(): Promise<{ dataset: string; elevation_m: number | null }> {
  const res = await getDemSamples([{ lat: 0, lon: 0 }]);
  return { dataset: res.dataset, elevation_m: res.samples[0]?.elevation_m_raw ?? null };
}

async function fetchJson<T>(url: string, _init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}