import { geodesicAreaM2, geodesicPerimeterM, computeMetrics, validatePolygon, closeRing, polygonCentroid, polygonBBox, haversine, ringSelfIntersects } from '@agrifur2/shared';

describe('geometry utilities (shared/geo)', () => {
  const smallSquare: [number, number][] = [
    [75.84, 18.51], [75.85, 18.51], [75.85, 18.52], [75.84, 18.52], [75.84, 18.51],
  ];
  const polygon: GeoJSON.Polygon = { type: 'Polygon', coordinates: [smallSquare] };

  test('computeMetrics yields positive, sane area/perimeter for ~1 km square', () => {
    const m = computeMetrics(polygon);
    expect(m.area_hectares).toBeGreaterThan(90);
    expect(m.area_hectares).toBeLessThan(120); // 0.01° x 0.01° ≈ 100 ha
    expect(m.perimeter_m).toBeGreaterThan(4200); // geodesic (haversine) edges ≈ 2×(1.112+1.055) km
    expect(m.perimeter_m).toBeLessThan(4400);
    expect(m.centroid.coordinates[0]).toBeCloseTo(75.845, 3);
    expect(m.centroid.coordinates[1]).toBeCloseTo(18.515, 3);
    expect(m.bbox).toEqual([75.84, 18.51, 75.85, 18.52]);
    expect(m.srid).toBe(4326);
  });

  test('area is orientation independent and closure independent', () => {
    const ring = smallSquare.slice();
    const rev = closeRing(ring.slice().reverse());
    const unclosed = ring.slice(0, -1);
    expect(Math.abs(geodesicAreaM2(ring) - geodesicAreaM2(rev))).toBeLessThan(0.5);
    expect(Math.abs(geodesicAreaM2(ring) - geodesicAreaM2(closeRing(unclosed)))).toBeLessThan(0.5);
  });

  test('haversine distance ~ 1.11 km for 0.01° latitude', () => {
    const d = haversine([75.84, 18.51], [75.84, 18.52]);
    expect(d).toBeGreaterThan(1100);
    expect(d).toBeLessThan(1120);
  });

  test('validation accepts a valid closed polygon and rejects bad ones', () => {
    expect(validatePolygon(polygon)).toHaveLength(0);
    const unclosed: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] };
    expect(validatePolygon(unclosed).map((i) => i.code)).toContain('NOT_CLOSED');
    const badLng: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[181, 0], [181, 1], [182, 1], [181, 0]]] };
    expect(validatePolygon(badLng).map((i) => i.code)).toContain('LNG_OUT_OF_RANGE');
    const bowtie: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [2, 2], [0, 2], [2, 0], [0, 0]]] };
    expect(ringSelfIntersects(bowtie.coordinates[0] as [number, number][])).toBe(true);
    expect(validatePolygon(bowtie).map((i) => i.code)).toContain('SELF_INTERSECTION');
  });

  test('closeRing never mutates input and idempotent', () => {
    const unclosed: [number, number][] = [[0, 0], [1, 0], [1, 1]];
    const before = JSON.stringify(unclosed);
    const closed = closeRing(unclosed);
    expect(JSON.stringify(unclosed)).toBe(before);
    expect(closed.length).toBe(4);
    expect(closeRing(closed)).toEqual(closed);
  });

  test('polygonCentroid inside bounding box', () => {
    const [cx, cy] = polygonCentroid(smallSquare);
    const [minX, minY, maxX, maxY] = polygonBBox(smallSquare);
    expect(cx).toBeGreaterThanOrEqual(minX);
    expect(cx).toBeLessThanOrEqual(maxX);
    expect(cy).toBeGreaterThanOrEqual(minY);
    expect(cy).toBeLessThanOrEqual(maxY);
  });
});
