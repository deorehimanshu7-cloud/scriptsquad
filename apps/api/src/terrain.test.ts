import { describe, expect, test } from "bun:test";
import { samplePointsInside, validateGeometry } from "./geo";
import { deriveTerrainStats, type TerrainStats } from "./services/terrain";
import type { DemSample } from "./providers/opentopodata";

const validPolygon = {
  type: "Polygon" as const,
  coordinates: [
    [
      [74.0, 20.5],
      [74.002, 20.5],
      [74.002, 20.502],
      [74.0, 20.502],
      [74.0, 20.5],
    ],
  ],
};

/** Build a regular lat/lon DEM grid with elevations z(i, j) (row = lat, col = lon). */
function makeGrid(
  lat0: number,
  lon0: number,
  step: number,
  z: (i: number, j: number) => number,
  n = 3,
): DemSample[] {
  const out: DemSample[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out.push({
        lat: lat0 + i * step,
        lon: lon0 + j * step,
        elevation_m_raw: z(i, j),
        elevation_m: z(i, j),
      });
    }
  }
  return out;
}

describe("samplePointsInside", () => {
  test("3x3 grid + centroid over the field bbox, all inside the polygon", () => {
    const v = validateGeometry(validPolygon);
    expect(v.ok).toBe(true);
    const pts = samplePointsInside(validPolygon, 3);
    // 3x3 interior cells are all inside this rectangular polygon; the centroid
    // coincides with the middle grid cell so it is deduplicated → 9 points
    expect(pts.length).toBe(9);
    for (const p of pts) {
      expect(p.lon).toBeGreaterThanOrEqual(74.0);
      expect(p.lon).toBeLessThanOrEqual(74.002);
      expect(p.lat).toBeGreaterThanOrEqual(20.5);
      expect(p.lat).toBeLessThanOrEqual(20.502);
    }
  });
});

describe("deriveTerrainStats", () => {
  test("min/max/mean/range over real samples", () => {
    const grid = makeGrid(20.5, 74.0, 0.001, (i, j) => 500 + i * 10 + j * 20);
    const s = deriveTerrainStats(grid);
    expect(s.min_m).toBe(500);
    expect(s.max_m).toBe(560);
    expect(s.mean_m).toBe(530);
    expect(s.range_m).toBe(60);
    expect(s.sample_count).toBe(9);
  });

  test("flat grid → slope 0", () => {
    const s = deriveTerrainStats(makeGrid(20.5, 74.0, 0.001, () => 577));
    expect(s.slope_degrees).toBe(0);
  });

  test("east-rising grid → small slope, aspect ≈ 270 (west-facing downhill)", () => {
    // elevation rises 0.5 m per 0.001° lon (~111.3 m) → slope ≈ atan(0.5/111.3)
    const grid = makeGrid(20.5, 74.0, 0.001, (_i, j) => 500 + j * 0.5);
    const s = deriveTerrainStats(grid);
    expect(s.slope_degrees).not.toBeNull();
    expect(s.slope_degrees!).toBeGreaterThan(0.2);
    expect(s.slope_degrees!).toBeLessThan(0.35);
    // downslope is toward the west
    expect(s.aspect_degrees!).toBeGreaterThan(260);
    expect(s.aspect_degrees!).toBeLessThan(280);
  });

  test("north-rising grid → aspect ≈ 180 (downhill south)", () => {
    // lats ascend south→north, so elevation rising with i means the terrain
    // rises northward → downhill faces south → aspect 180.
    const grid = makeGrid(20.5, 74.0, 0.001, (i, _j) => 500 + i * 0.5);
    const s = deriveTerrainStats(grid);
    expect(s.slope_degrees).not.toBeNull();
    expect(s.aspect_degrees!).toBeGreaterThan(170);
    expect(s.aspect_degrees!).toBeLessThan(190);
  });

  test("4-point grid (no 3x3 window) → least-squares plane fit derives exact slope/aspect", () => {
    // 2×2 corners: no complete 3×3 window exists → LSQ path. All 4 points lie
    // on a plane rising eastward, so the fit recovers it exactly.
    const grid = makeGrid(20.5, 74.0, 0.001, (_i, j) => 500 + j * 0.5, 2);
    expect(grid.length).toBe(4);
    const s = deriveTerrainStats(grid);
    expect(s.slope_degrees).not.toBeNull();
    expect(s.slope_degrees!).toBeGreaterThan(0.2);
    expect(s.slope_degrees!).toBeLessThan(0.35);
    expect(s.aspect_degrees!).toBeGreaterThan(260);
    expect(s.aspect_degrees!).toBeLessThan(280);
    expect(s.method).toContain("Least-squares");
  });

  test("fewer than 3x3 usable samples → slope/aspect honestly null", () => {
    const s = deriveTerrainStats([
      { lat: 20.5, lon: 74.0, elevation_m_raw: 500, elevation_m: 500 },
      { lat: 20.501, lon: 74.0, elevation_m_raw: 510, elevation_m: 510 },
      { lat: 20.5, lon: 74.001, elevation_m_raw: 520, elevation_m: 520 },
    ]);
    expect(s.slope_degrees).toBeNull();
    expect(s.aspect_degrees).toBeNull();
    expect(s.mean_m).toBe(510);
  });

  test("no usable samples → all-zero stats, null slope/aspect", () => {
    const s: TerrainStats = deriveTerrainStats([
      { lat: 20.5, lon: 74.0, elevation_m_raw: null, elevation_m: 0 },
    ]);
    expect(s.sample_count).toBe(0);
    expect(s.slope_degrees).toBeNull();
    expect(s.aspect_degrees).toBeNull();
  });
});