import type { FieldGeometry } from "contracts";
import { round } from "./util";

export interface LonLat {
  lon: number;
  lat: number;
}

export interface BBox {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

/**
 * Geometric helpers. Coordinate handling is deliberately simple and
 * transparent: polygons are WGS84 lon/lat rings; area uses an equirectangular
 * approximation at the centroid latitude (error grows away from equator; a
 * PostGIS production backend should use geography-correct area instead).
 */

function rings(g: FieldGeometry): LonLat[][] {
  const coords = g.coordinates as unknown;
  if (g.type === "Polygon") {
    return (coords as number[][][]).map((ring) => ring.map(([lon, lat]) => ({ lon, lat })));
  }
  // MultiPolygon: coordinates[][][][] (polygon -> ring -> position)
  return (coords as number[][][][]).flatMap((poly) => poly.map((ring) => ring.map(([lon, lat]) => ({ lon, lat }))));
}

export function validateGeometry(g: FieldGeometry): { ok: true } | { ok: false; error: string } {
  if (!g || (g.type !== "Polygon" && g.type !== "MultiPolygon")) {
    return { ok: false, error: "geometry.type must be Polygon or MultiPolygon" };
  }
  try {
    const rs = rings(g);
    if (rs.length === 0) return { ok: false, error: "no rings" };
    for (const r of rs) {
      if (r.length < 4) return { ok: false, error: "a ring needs at least 4 positions" };
      const first = r[0];
      const last = r[r.length - 1];
      if (Math.abs(first.lon - last.lon) > 1e-9 || Math.abs(first.lat - last.lat) > 1e-9) {
        return { ok: false, error: "ring is not closed" };
      }
      for (const p of r) {
        if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return { ok: false, error: "non finite coordinate" };
        if (Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180) return { ok: false, error: "coordinate out of range" };
      }
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "invalid geometry structure" };
  }
}

export function bboxOf(g: FieldGeometry): BBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const r of rings(g)) {
    for (const p of r) {
      minLon = Math.min(minLon, p.lon);
      minLat = Math.min(minLat, p.lat);
      maxLon = Math.max(maxLon, p.lon);
      maxLat = Math.max(maxLat, p.lat);
    }
  }
  return { min_lon: minLon, min_lat: minLat, max_lon: maxLon, max_lat: maxLat };
}

export function centroidOf(g: FieldGeometry): LonLat {
  const bb = bboxOf(g);
  return { lon: (bb.min_lon + bb.max_lon) / 2, lat: (bb.min_lat + bb.max_lat) / 2 };
}

/** Area in square metres via equirectangular approximation. */
export function areaM2(g: FieldGeometry): number | null {
  const c = centroidOf(g);
  const cosLat = Math.cos((c.lat * Math.PI) / 180);
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * cosLat;
  let area = 0;
  for (const r of rings(g)) {
    // shoelace in metres
    let sum = 0;
    for (let i = 0; i < r.length - 1; i++) {
      const x1 = r[i].lon * mPerDegLon;
      const y1 = r[i].lat * mPerDegLat;
      const x2 = r[i + 1].lon * mPerDegLon;
      const y2 = r[i + 1].lat * mPerDegLat;
      sum += x1 * y2 - x2 * y1;
    }
    area += Math.abs(sum) / 2;
  }
  if (!Number.isFinite(area) || area <= 0) return null;
  return round(area, 0);
}

/** STAC-style AOI bbox string [west,south,east,north]. */
export function aoiBbox(g: FieldGeometry): [number, number, number, number] {
  const b = bboxOf(g);
  return [round(b.min_lon, 6), round(b.min_lat, 6), round(b.max_lon, 6), round(b.max_lat, 6)];
}

export function toGeoJsonFeature(g: FieldGeometry): Record<string, unknown> {
  return { type: "Feature", properties: {}, geometry: g };
}

/**
 * Point-in-polygon via ray casting over all rings of a Polygon/MultiPolygon.
 * Supports both our FieldGeometry and STAC footprint geometries.
 */
function pointInPolygons(lon: number, lat: number, geom: { type?: string; coordinates?: unknown }): boolean {
  const coords = geom.coordinates as unknown;
  if (!coords) return false;
  const polygons: unknown[][][][] =
    geom.type === "Polygon" ? [coords as number[][][]] : (coords as number[][][][]);
  for (const polygon of polygons) {
    for (const ring of polygon as number[][][]) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
      }
      if (inside) return true;
    }
  }
  return false;
}

/**
 * Uniform n×n grid over the field bbox plus the centroid, keeping only points
 * inside the polygon. Used to sample real DEM rasters across the field. The
 * returned points are real coordinates within the field boundary — nothing is
 * fabricated.
 */
export function samplePointsInside(g: FieldGeometry, n: number): LonLat[] {
  const b = bboxOf(g);
  const spanLon = Math.max(b.max_lon - b.min_lon, 1e-7);
  const spanLat = Math.max(b.max_lat - b.min_lat, 1e-7);
  const pts: LonLat[] = [];
  const seen = new Set<string>();
  const add = (lon: number, lat: number) => {
    const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    pts.push({ lon, lat });
  };
  for (let ix = 0; ix < n; ix++) {
    for (let iy = 0; iy < n; iy++) {
      const lon = b.min_lon + ((ix + 0.5) / n) * spanLon;
      const lat = b.min_lat + ((iy + 0.5) / n) * spanLat;
      if (pointInPolygons(lon, lat, g)) add(lon, lat);
    }
  }
  const c = centroidOf(g);
  if (pointInPolygons(c.lon, c.lat, g)) add(c.lon, c.lat);
  return pts;
}

/**
 * Estimated percentage of the field polygon that a STAC acquisition footprint
 * covers, computed by uniform grid sampling over the field's bounding box
 * (≈100 points). Honest label: ESTIMATED — not an exact planar intersection.
 * Returns null when the footprint has no usable polygon geometry.
 */
export function fieldIntersectionPct(field: FieldGeometry, footprint: unknown): number | null {
  if (!field || !footprint) return null;
  const fp = footprint as { type?: string; coordinates?: unknown };
  if (!fp || !fp.coordinates) return null;
  const b = bboxOf(field);
  const spanLon = Math.max(b.max_lon - b.min_lon, 1e-6);
  const spanLat = Math.max(b.max_lat - b.min_lat, 1e-6);
  const N = 12;
  let inField = 0;
  let inBoth = 0;
  for (let ix = 0; ix < N; ix++) {
    for (let iy = 0; iy < N; iy++) {
      const lon = b.min_lon + ((ix + 0.5) / N) * spanLon;
      const lat = b.min_lat + ((iy + 0.5) / N) * spanLat;
      if (!pointInPolygons(lon, lat, field)) continue;
      inField++;
      if (pointInPolygons(lon, lat, fp)) inBoth++;
    }
  }
  if (inField === 0) return null;
  return round((inBoth / inField) * 100, 1);
}
