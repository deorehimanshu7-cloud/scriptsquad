/**
 * Terrain derivations from real DEM samples.
 *
 * Pure functions (no I/O) so they can be unit-tested deterministically. All
 * outputs are DERIVED: they are statistics / gradients computed from real DEM
 * raster samples, never survey measurements.
 */
import type { DemSample } from "../providers/opentopodata";
import { round } from "../util";

export interface TerrainStats {
  min_m: number;
  max_m: number;
  mean_m: number;
  range_m: number;
  sample_count: number;
  /** null when fewer than 4 usable samples exist (honest UNKNOWN) */
  slope_degrees: number | null;
  /** null when fewer than 4 usable samples exist (honest UNKNOWN) */
  aspect_degrees: number | null;
  method: string;
}

/**
 * Elevation statistics + slope/aspect from a set of DEM samples.
 *
 * Slope/aspect prefer Horn's method (finite differences) over a complete 3×3
 * window of the sampled grid. When the field polygon leaves no complete 3×3
 * window, a least-squares planar fit (z = a·x + b·y + c) over all samples is
 * used instead — both are documented derivations from the real samples. With
 * fewer than 4 samples, slope/aspect are null (honest UNKNOWN).
 */
export function deriveTerrainStats(samples: DemSample[]): TerrainStats {
  const usable = samples.filter((s) => s.elevation_m_raw !== null && Number.isFinite(s.elevation_m_raw));
  const values = usable.map((s) => s.elevation_m_raw as number);
  if (values.length === 0) {
    return {
      min_m: 0,
      max_m: 0,
      mean_m: 0,
      range_m: 0,
      sample_count: 0,
      slope_degrees: null,
      aspect_degrees: null,
      method: "no usable DEM samples",
    };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;

  let slope: number | null = null;
  let aspect: number | null = null;
  let method =
    "SRTM 90 m / ASTER 30 m DEM raster samples inside the field polygon; slope/aspect via Horn finite differences over the sampled grid — all DERIVED.";

  const lats = [...new Set(usable.map((s) => s.lat))].sort((a, b) => a - b);
  const lons = [...new Set(usable.map((s) => s.lon))].sort((a, b) => a - b);
  const mPerDegLat = 111_320;
  const cLat = lats.length ? (lats[0] + lats[lats.length - 1]) / 2 : 0;
  const mPerDegLon = 111_320 * Math.cos((cLat * Math.PI) / 180);

  // 1) Horn's method over interior cells of a complete 3×3 window.
  if (lats.length >= 3 && lons.length >= 3) {
    const dyM = (lats[1] - lats[0]) * mPerDegLat;
    const dxM = (lons[1] - lons[0]) * mPerDegLon;
    if (dyM > 0 && dxM > 0) {
      const z = (lat: number, lon: number): number | null => {
        const s = usable.find((x) => Math.abs(x.lat - lat) < 1e-9 && Math.abs(x.lon - lon) < 1e-9);
        return s ? s.elevation_m_raw : null;
      };
      let slopeSum = 0;
      let aspectSum = 0;
      let n = 0;
      for (let i = 1; i < lats.length - 1; i++) {
        for (let j = 1; j < lons.length - 1; j++) {
          // 3×3 window around the interior cell; lats ascend south→north,
          // lons ascend west→east. Horn (1981):
          //   NW  N  NE        zNW = z(lats[i+1], lons[j-1]) etc.
          //   W   e  E
          //   SW  S  SE
          const zNW = z(lats[i + 1], lons[j - 1]);
          const zN = z(lats[i + 1], lons[j]);
          const zNE = z(lats[i + 1], lons[j + 1]);
          const zW = z(lats[i], lons[j - 1]);
          const zE = z(lats[i], lons[j + 1]);
          const zSW = z(lats[i - 1], lons[j - 1]);
          const zS = z(lats[i - 1], lons[j]);
          const zSE = z(lats[i - 1], lons[j + 1]);
          if ([zNW, zN, zNE, zW, zE, zSW, zS, zSE].some((v) => v === null)) continue;
          const dzdx = (zNE! + 2 * zE! + zSE! - (zNW! + 2 * zW! + zSW!)) / (8 * dxM);
          const dzdy = (zNW! + 2 * zN! + zNE! - (zSW! + 2 * zS! + zSE!)) / (8 * dyM);
          const sDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
          // downslope compass azimuth (0=N, 90=E, 180=S, 270=W)
          let aDeg = (Math.atan2(-dzdx, -dzdy) * 180) / Math.PI;
          if (aDeg < 0) aDeg += 360;
          slopeSum += sDeg;
          aspectSum += aDeg;
          n++;
        }
      }
      if (n > 0) {
        slope = round(slopeSum / n, 1);
        aspect = round(aspectSum / n, 0);
      }
    }
  }

  // 2) Fallback: no complete 3×3 window (irregular polygon dropped a cell).
  //    Fit a least-squares plane over all samples in local metres, using
  //    mean-centered coordinates (numerically stable normal equations).
  if (slope === null && usable.length >= 4) {
    const X: number[] = [];
    const Y: number[] = [];
    const Z: number[] = [];
    for (const s of usable) {
      X.push((s.lon - lons[0]) * mPerDegLon);
      Y.push((s.lat - lats[0]) * mPerDegLat);
      Z.push(s.elevation_m_raw as number);
    }
    const n = X.length;
    const mx = X.reduce((a, b) => a + b, 0) / n;
    const my = Y.reduce((a, b) => a + b, 0) / n;
    const mz = Z.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    let sxz = 0;
    let syz = 0;
    for (let i = 0; i < n; i++) {
      const xc = X[i] - mx;
      const yc = Y[i] - my;
      const zc = Z[i] - mz;
      sxx += xc * xc;
      syy += yc * yc;
      sxy += xc * yc;
      sxz += xc * zc;
      syz += yc * zc;
    }
    const det = sxx * syy - sxy * sxy;
    if (Math.abs(det) > 1e-12) {
      const a = (sxz * syy - syz * sxy) / det;
      const b = (syz * sxx - sxz * sxy) / det;
      slope = round((Math.atan(Math.hypot(a, b)) * 180) / Math.PI, 1);
      let aDeg = (Math.atan2(-a, -b) * 180) / Math.PI; // downslope compass azimuth
      if (aDeg < 0) aDeg += 360;
      aspect = round(aDeg, 0);
      method = `Least-squares planar fit over ${n} DEM samples (no complete 3×3 window inside the field polygon); slope/aspect are DERIVED from the real samples.`;
    }
  }

  return {
    min_m: round(min, 1),
    max_m: round(max, 1),
    mean_m: round(mean, 1),
    range_m: round(max - min, 1),
    sample_count: usable.length,
    slope_degrees: slope,
    aspect_degrees: aspect,
    method,
  };
}