// ============================================================================
// AGRIFUR2 Geometry utilities
//
// Production truth: PostgreSQL + PostGIS computes every metric
// (ST_Area on a projected CRS, ST_Perimeter, ST_Centroid, ST_Envelope,
// ST_IsValid, ...). These utilities are used ONLY by:
//  1. sqlite-dev development mode (labelled, never claimed as PostGIS output)
//  2. frontend client-side validation / preview
// Coordinates are GeoJSON [lng, lat], SRID 4326.
// ============================================================================

export type LngLat = [number, number];
export type Ring = LngLat[];

export interface GeoMetrics {
  area_m2: number;
  area_hectares: number;
  perimeter_m: number;
  centroid: { type: 'Point'; coordinates: [number, number] };
  bbox: [number, number, number, number]; // minLng, minLat, maxLng, maxLat
  srid: 4326;
  valid: boolean | null;
}

const R = 6371008.8; // mean Earth radius (m) — matches common geodesic libs
const DEG = Math.PI / 180;

function toRad(d: number): number {
  return d * DEG;
}

/** Great-circle distance between two [lng,lat] points (haversine). */
export function haversine(a: LngLat, b: LngLat): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Geodesic area of a polygon ring via the spherical-excess approximation:
 * A = R²/2 · | Σ (λ₂−λ₁)·(2 + sin φ₁ + sin φ₂) |
 * Accurate to well under 1% for field-scale polygons; documented tolerance.
 * Ring does not need to be explicitly closed (last point is joined to first).
 */
export function geodesicAreaM2(ring: Ring): number {
  if (ring.length < 3) return 0;
  let total = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    if (p1[0] === p2[0] && p1[1] === p2[1]) continue;
    total += toRad(p2[0] - p1[0]) * (2 + Math.sin(toRad(p1[1])) + Math.sin(toRad(p2[1])));
  }
  return Math.abs((R * R * total) / 2);
}

/** Geodesic perimeter of a ring (may be unclosed — closure not double-counted). */
export function geodesicPerimeterM(ring: Ring): number {
  if (ring.length < 2) return 0;
  let perim = 0;
  const effective = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;
  for (let i = 0; i < effective.length; i++) {
    perim += haversine(effective[i], effective[(i + 1) % effective.length]);
  }
  return perim;
}

/**
 * Planar ring area after equirectangular projection about the ring's mean
 * latitude. Used for the client-side preview only.
 */
export function planarAreaM2(ring: Ring): number {
  if (ring.length < 3) return 0;
  let sumLat = 0;
  for (const c of ring) sumLat += c[1];
  const meanLat = sumLat / ring.length;
  const cosLat = Math.max(Math.cos(toRad(meanLat)), 1e-6);
  const x = (lng: number) => toRad(lng) * R * cosLat;
  const y = (lat: number) => toRad(lat) * R;
  let area = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    area += x(a[0]) * y(b[1]) - x(b[0]) * y(a[1]);
  }
  return Math.abs(area) / 2;
}

/** Area-weighted centroid of a ring in projected local meters, converted back to [lng, lat]. */
export function polygonCentroid(ring: Ring): LngLat {
  if (ring.length < 3) return ring[0] || [0, 0];
  let sumLat = 0;
  for (const c of ring) sumLat += c[1];
  const meanLat = sumLat / ring.length;
  const cosLat = Math.max(Math.cos(toRad(meanLat)), 1e-9);
  const oLng = ring[0][0];
  const oLat = ring[0][1];
  const X = (lng: number) => toRad(lng - oLng) * R * cosLat;
  const Y = (lat: number) => toRad(lat - oLat) * R;
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const cross = X(p1[0]) * Y(p2[1]) - X(p2[0]) * Y(p1[1]);
    a += cross;
    cx += (X(p1[0]) + X(p2[0])) * cross;
    cy += (Y(p1[1]) + Y(p2[1])) * cross;
  }
  if (Math.abs(a) < 1e-12) return ring[0];
  const cX = cx / (3 * a);
  const cY = cy / (3 * a);
  return [oLng + cX / (R * cosLat) / DEG, oLat + cY / R / DEG];
}

export function polygonBBox(ring: Ring): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of ring) {
    if (c[0] < minX) minX = c[0];
    if (c[1] < minY) minY = c[1];
    if (c[0] > maxX) maxX = c[0];
    if (c[1] > maxY) maxY = c[1];
  }
  return [minX, minY, maxX, maxY];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
export interface ValidationIssue {
  code: string;
  message: string;
}

/** Basic coordinate sanity: valid numbers, lng ∈ [-180,180], lat ∈ [-90,90]. */
export function validateRingCoords(ring: Ring): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const [i, c] of ring.entries()) {
    if (!Array.isArray(c) || c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) {
      issues.push({ code: 'INVALID_COORD', message: `Coordinate ${i} is not a valid [lng, lat] pair` });
      continue;
    }
    if (c[0] < -180 || c[0] > 180) issues.push({ code: 'LNG_OUT_OF_RANGE', message: `Coordinate ${i} longitude ${c[0]} outside [-180,180]` });
    if (c[1] < -90 || c[1] > 90) issues.push({ code: 'LAT_OUT_OF_RANGE', message: `Coordinate ${i} latitude ${c[1]} outside [-90,90]` });
  }
  return issues;
}

function segIntersect(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  const orient = (p: LngLat, q: LngLat, r: LngLat) =>
    (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  const onSeg = (p: LngLat, q: LngLat, r: LngLat) =>
    Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) &&
    Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/**
 * Detect self-intersections between non-adjacent edges (bowtie detection).
 * A closed ring's repeated last point is ignored so the duplicate closing edge
 * is not tested against itself; edges sharing a vertex are never considered
 * intersecting.
 */
export function ringSelfIntersects(ring: Ring): boolean {
  const n = ring.length;
  const closed = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1];
  const m = closed ? n - 1 : n;
  const edges: LngLat[][] = [];
  for (let i = 0; i < m; i++) edges.push([ring[i], ring[(i + 1) % m]]);
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const a = edges[i];
      const b = edges[j];
      const shareVertex =
        (a[0][0] === b[0][0] && a[0][1] === b[0][1]) ||
        (a[0][0] === b[1][0] && a[0][1] === b[1][1]) ||
        (a[1][0] === b[0][0] && a[1][1] === b[0][1]) ||
        (a[1][0] === b[1][0] && a[1][1] === b[1][1]);
      if (shareVertex) continue;
      if (segIntersect(a[0], a[1], b[0], b[1])) return true;
    }
  }
  return false;
}

/** Validate a GeoJSON Polygon ring. Returns issues (empty = passes). */
export function validatePolygon(geometry: GeoJSON.Polygon): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!geometry || geometry.type !== 'Polygon') {
    return [{ code: 'NOT_POLYGON', message: 'Geometry must be a GeoJSON Polygon' }];
  }
  const ring = geometry.coordinates?.[0] as unknown as Ring;
  if (!ring || ring.length < 4) {
    issues.push({ code: 'TOO_FEW_POINTS', message: 'Polygon must have at least 4 positions (3 + closure)' });
    return issues;
  }
  issues.push(...validateRingCoords(ring));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    issues.push({ code: 'NOT_CLOSED', message: 'Polygon ring must be closed (first == last)' });
  }
  if (ring.length > 4 && ringSelfIntersects(ring)) {
    issues.push({ code: 'SELF_INTERSECTION', message: 'Polygon ring self-intersects (bowtie) — invalid' });
  }
  return issues;
}

/** Close an unclosed ring (returns a new array; never mutates input). */
export function closeRing(ring: Ring): Ring {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/** Compute full metrics for the outer ring of a polygon. */
export function computeMetrics(geometry: GeoJSON.Polygon): GeoMetrics {
  const ring = closeRing(geometry.coordinates[0] as LngLat[]);
  const area_m2 = geodesicAreaM2(ring);
  const perimeter_m = geodesicPerimeterM(ring);
  const [clng, clat] = polygonCentroid(ring);
  return {
    area_m2,
    area_hectares: area_m2 / 10000,
    perimeter_m,
    centroid: { type: 'Point', coordinates: [clng, clat] },
    bbox: polygonBBox(ring),
    srid: 4326,
    valid: validatePolygon(geometry).length === 0 ? true : null,
  };
}

export function bboxToPolygon(bbox: [number, number, number, number]): GeoJSON.Polygon {
  const [minX, minY, maxX, maxY] = bbox;
  return {
    type: 'Polygon',
    coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
  };
}
