import { describe, expect, test } from "bun:test";
import { areaM2, bboxOf, centroidOf, validateGeometry } from "./geo";
import type { FieldGeometry } from "contracts";

// Position/Polygon typing per GeoJSON spec:
//   Position = number[]; Polygon.coordinates = number[][][]; MultiPolygon = number[][][][]
const validPolygon: FieldGeometry = {
  type: "Polygon",
  coordinates: [
    [
      [73.7882, 20.0001],
      [73.7891, 20.0004],
      [73.7904, 20.0005],
      [73.7916, 20.0002],
      [73.7882, 20.0001],
    ],
  ],
};

const validMulti: FieldGeometry = {
  type: "MultiPolygon",
  coordinates: [
    [
      [
        [73.7882, 20.0001],
        [73.7891, 20.0004],
        [73.7904, 20.0005],
        [73.7882, 20.0001],
      ],
    ],
    [
      [
        [73.7904, 20.0005],
        [73.7916, 20.0002],
        [73.7923, 19.9993],
        [73.7904, 20.0005],
      ],
    ],
  ],
};

describe("validateGeometry", () => {
  test("accepts a closed Polygon", () => {
    expect(validateGeometry(validPolygon).ok).toBe(true);
  });

  test("accepts a closed MultiPolygon without casting to Polygon", () => {
    expect(validMulti.type).toBe("MultiPolygon");
    expect(validateGeometry(validMulti).ok).toBe(true);
  });

  test("rejects an unclosed ring", () => {
    const open = {
      type: "Polygon",
      coordinates: [
        [
          [73.7882, 20.0001],
          [73.7891, 20.0004],
          [73.7904, 20.0005],
          [73.7916, 20.0002], // missing return to first vertex
        ],
      ],
    } as unknown as FieldGeometry;
    const r = validateGeometry(open);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("closed");
  });

  test("rejects out-of-range coordinates", () => {
    const badLat = {
      type: "Polygon",
      coordinates: [
        [
          [73.7882, 20.0001],
          [73.7891, 120.0], // latitude beyond ±85 is not a valid field location
          [73.7904, 20.0005],
          [73.7882, 20.0001],
        ],
      ],
    } as unknown as FieldGeometry;
    const r = validateGeometry(badLat);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("out of range");
  });

  test("rejects degenerate structures", () => {
    expect(validateGeometry(null as unknown as FieldGeometry).ok).toBe(false);
    expect(validateGeometry({ type: "Point", coordinates: [1, 2] } as unknown as FieldGeometry).ok).toBe(false);
  });
});

describe("derived geometry", () => {
  test("bbox and centroid sit inside the ring", () => {
    const bb = bboxOf(validPolygon);
    expect(bb.min_lon).toBeLessThan(bb.max_lon);
    expect(bb.min_lat).toBeLessThan(bb.max_lat);
    const c = centroidOf(validPolygon);
    expect(c.lon).toBeCloseTo((73.7882 + 73.7916) / 2, 5);
    expect(c.lat).toBeGreaterThan(20.0001);
    expect(c.lat).toBeLessThan(20.0005);
  });

  test("area is positive and finite for both types", () => {
    const aPoly = areaM2(validPolygon);
    expect(aPoly).not.toBeNull();
    expect(aPoly!).toBeGreaterThan(0);
    const aMulti = areaM2(validMulti);
    expect(aMulti).not.toBeNull();
    expect(aMulti!).toBeGreaterThan(0);
    expect(Number.isFinite(aPoly) && Number.isFinite(aMulti)).toBe(true);
  });

  test("Polygon is never silently cast to MultiPolygon shape", () => {
    // a Polygon must stay number[][][] — validate rejects the 4-deep shape
    const miscast = {
      type: "Polygon",
      coordinates: [[[[73.7882, 20.0001]]]],
    } as unknown as FieldGeometry;
    expect(validateGeometry(miscast).ok).toBe(false);
  });
});
