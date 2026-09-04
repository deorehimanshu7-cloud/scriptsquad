import { inflateSync } from "node:zlib";
import { SOIL_PROPERTY_UNITS, type SoilPropertyRow } from "./soilgrids";

/**
 * ISRIC SoilGrids WCS fallback provider (maps.isric.org).
 *
 * The SoilGrids v2.0 REST API (rest.isric.org) has been paused by ISRIC, but
 * the public WCS map server is still live and keyless. This module pulls the
 * same SoilGrids v2.0 250 m model values via WCS GetCoverage over a small box
 * around the field centroid (EPSG:3857 — the EPSG:4326 subsetting path returns
 * nodata artefacts on this server) and averages the valid cells it returns.
 *
 * TRUTHFULNESS — this is still MODEL ESTIMATE data (a global 250 m grid), NOT
 * field measurements:
 *   - every row is emitted in the exact unit conventions the REST API used
 *     (declared by ISRIC's own layer titles, e.g. "pH*10", "dg/kg", "g/kg"),
 *   - callers must store the rows with state ESTIMATED,
 *   - the layer only covers the 0-5 cm depth on this fallback path,
 *   - ISRIC's coverage has gaps (nodata cells); only valid cells are averaged
 *     and a property with no valid cells nearby is reported as null.
 *
 * Raw integer scales per ISRIC layer title (value returned = title unit):
 *   phh2o    → "pH in H2O (pH*10)"        → REST convention mean = raw / 1
 *   soc      → "(dg/kg)" = g/kg * 10      → REST convention mean = raw / 10
 *   clay     → "(g/kg)"                   → raw / 1
 *   sand     → "(g/kg)"                   → raw / 1
 *   silt     → "(g/kg)"                   → raw / 1
 *   bdod     → "(cg/cm3)"                 → raw / 1
 *   cec      → "(mmol(c)/kg)"             → raw / 1
 *   nitrogen → "(cg/kg)" = g/kg * 10      → REST convention mean = raw / 10
 */

const PROPERTIES = ["phh2o", "soc", "clay", "sand", "silt", "bdod", "cec", "nitrogen"] as const;

/** Divide the raw WCS integer by this to get the REST-convention value. */
const WCS_TO_REST_SCALE: Record<string, number> = {
  phh2o: 1, // pH*10 (same convention REST reports)
  soc: 10, // dg/kg → g/kg
  clay: 1, // g/kg
  sand: 1,
  silt: 1,
  bdod: 1, // cg/cm3
  cec: 1, // mmol(c)/kg
  nitrogen: 10, // cg/kg → g/kg
};

/** Generous plausibility windows in REST-convention units (guards against nodata/scale garbage). */
const PLAUSIBLE: Record<string, [number, number]> = {
  phh2o: [20, 140], // pH*10 → pH 2.0–14.0 after the /10 conversion downstream
  soc: [1, 2000], // g/kg
  clay: [1, 1000], // g/kg
  sand: [1, 1000],
  silt: [1, 1000],
  bdod: [10, 260], // cg/cm3
  cec: [1, 600], // mmol(c)/kg
  nitrogen: [1, 1000], // g/kg
};

const WCS_ENDPOINT = "https://maps.isric.org/mapserv";

interface Coverage {
  width: number;
  height: number;
  values: number[]; // valid (non-nodata) decoded cells
}

// ---------------------------------------------------------------------------
// Minimal GeoTIFF reader for MapServer WCS output (zlib-compressed tiles,
// 16-bit samples, horizontal predictor). Only the tags we need are read.
// ---------------------------------------------------------------------------
function readCoverageTiff(tiff: Uint8Array): Coverage | null {
  const b = Buffer.from(tiff);
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (!le && !(b[0] === 0x4d && b[1] === 0x4d)) return null;
  const u16 = (o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const n = u16(ifd);
  if (!Number.isFinite(n) || n < 1 || n > 200) return null;

  const tags = new Map<number, { type: number; count: number; value: number }>();
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 11: 4, 12: 8 };
    const sz = size[type] ?? 1;
    if (tag === 42113) continue; // GDAL_NODATA — parsed separately below
    let value: number;
    if (sz * count <= 4) {
      if (type === 3) value = u16(e + 8);
      else if (type === 4) value = u32(e + 8);
      else if (type === 1) value = b[e + 8];
      else continue;
    } else if (count === 1 && (type === 4 || type === 3)) {
      value = type === 4 ? u32(e + 8) : u16(e + 8);
    } else {
      value = u32(e + 8); // offset to the value array (tile offsets / byte counts)
    }
    tags.set(tag, { type, count, value });
  }

  const width = tags.get(256)?.value ?? 0;
  const height = tags.get(257)?.value ?? 0;
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  const bits = tags.get(258)?.value ?? 16;
  const compression = tags.get(259)?.value ?? 1;
  if (bits !== 16 || compression !== 8) return null; // only the observed zlib/uint16 layout
  const tileWidth = tags.get(322)?.value ?? width;
  const tileHeight = tags.get(323)?.value ?? height;
  const predictor = tags.get(317)?.value ?? 1;

  // nodata string (tag 42113 is ASCII at a file offset)
  let nodata: number | null = null;
  for (let i = 0; i < n; i++) {
    const ent = ifd + 2 + i * 12;
    if (u16(ent) === 42113) {
      const off = u32(ent + 8);
      const raw = b.subarray(off, off + 16).toString("latin1");
      const m = raw.match(/-?\d+(\.\d+)?/);
      if (m) {
        nodata = parseFloat(m[0]);
        // Pixels are read as unsigned 16-bit; a nodata of -32768 means 0x8000.
        if (nodata < 0) nodata += 65536;
      }
      break;
    }
  }

  const tilesX = Math.ceil(width / tileWidth);
  const tilesY = Math.ceil(height / tileHeight);
  const pix = new Float64Array(width * height).fill(NaN);

  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const tileIndex = ty * tilesX + tx;
      let off = tags.get(324)?.value ?? 0;
      let byteCount = tags.get(325)?.value ?? 0;
      const offCount = tags.get(324)?.count ?? 1;
      const bcCount = tags.get(325)?.count ?? 1;
      if (offCount > 1) off = u32(off + tileIndex * 4);
      if (bcCount > 1) byteCount = u32(byteCount + tileIndex * 4);
      if (off <= 0 || byteCount <= 0 || off + byteCount > b.length) continue;
      let tile: Buffer;
      try {
        tile = inflateSync(b.subarray(off, off + byteCount)); // zlib framing
      } catch {
        continue;
      }
      const rowBytes = tileWidth * 2;
      if (predictor === 2) {
        for (let row = 0; row < tileHeight; row++) {
          let prev = 0;
          for (let c = 0; c < tileWidth; c++) {
            const at = row * rowBytes + c * 2;
            if (at + 1 >= tile.length) break;
            const s = le ? tile.readUInt16LE(at) : tile.readUInt16BE(at);
            prev = (s + prev) & 0xffff;
            if (le) tile.writeUInt16LE(prev, at);
            else tile.writeUInt16BE(prev, at);
          }
        }
      }
      for (let row = 0; row < tileHeight; row++) {
        for (let c = 0; c < tileWidth; c++) {
          const gx = tx * tileWidth + c;
          const gy = ty * tileHeight + row;
          if (gx >= width || gy >= height) continue;
          const at = row * rowBytes + c * 2;
          if (at + 1 >= tile.length) continue;
          const s = le ? tile.readUInt16LE(at) : tile.readUInt16BE(at);
          if (nodata !== null && s === nodata) continue;
          pix[gy * width + gx] = s;
        }
      }
    }
  }

  const values: number[] = [];
  for (const v of pix) if (Number.isFinite(v)) values.push(v);
  return { width, height, values };
}

function extractTiffFromMultipart(buf: Buffer): Buffer | null {
  const magic = Buffer.from([0x49, 0x49, 0x2a, 0x00]);
  let idx = buf.indexOf(magic);
  if (idx < 0) {
    idx = buf.indexOf(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]));
  }
  if (idx < 0) return null;
  return buf.subarray(idx);
}

/** WGS84 → EPSG:3857 Web Mercator (meters). */
function toMercator(lat: number, lon: number): [number, number] {
  const r = 20037508.342789244 / 180;
  const x = lon * r;
  const y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180) * r;
  return [x, y];
}

async function fetchCoverageMean(property: string, mx: number, my: number, halfMeters: number): Promise<number | null> {
  const params = new URLSearchParams({
    map: `/map/${property}.map`,
    SERVICE: "WCS",
    VERSION: "1.1.2",
    REQUEST: "GetCoverage",
    IDENTIFIER: `${property}_0-5cm_mean`,
    BBOX: `${mx - halfMeters},${my - halfMeters},${mx + halfMeters},${my + halfMeters}`,
    CRS: "EPSG:3857",
    FORMAT: "image/tiff",
    RESOLUTION: "250,250",
  });
  const url = `${WCS_ENDPOINT}?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) throw new Error(`WCS HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  const tiff = extractTiffFromMultipart(buf);
  if (!tiff) throw new Error("WCS returned no GeoTIFF part");
  const cov = readCoverageTiff(tiff);
  if (!cov || cov.values.length === 0) return null; // all cells nodata in this box
  let rawMean = 0;
  for (const v of cov.values) rawMean += v;
  return rawMean / cov.values.length;
}

/**
 * Fallback SoilGrids query over the live WCS map server (EPSG:3857).
 * Returns rows in the same shape/unit conventions as the REST adapter (the
 * caller must store them with state ESTIMATED). Only the 0-5 cm depth exists
 * on this path; each value is the mean of the valid 250 m modelled cells in a
 * ~3 km box around the field centroid (widened to ~8 km when the inner box is
 * entirely nodata — ISRIC's coverage has gaps). Properties with no valid cells
 * nearby are omitted; if none come back at all the function throws.
 */
/**
 * Availability probe for the periodic provider-health job: the REST API is
 * paused by ISRIC, so probe the live WCS map server at a coordinate known to
 * have model cells. Returns "ok" or throws.
 */
export async function pingSoilGridsWcs(): Promise<string> {
  const [mx, my] = toMercator(52.2, 0.1);
  for (const half of [1500, 4000]) {
    const v = await fetchCoverageMean("phh2o", mx, my, half);
    if (v !== null) return "ok";
  }
  throw new Error("SoilGrids WCS probe found no valid cells");
}

export async function getSoilPropertiesWcs(
  lat: number,
  lon: number,
): Promise<SoilPropertyRow[]> {
  const [mx, my] = toMercator(lat, lon);
  const rows: SoilPropertyRow[] = [];
  let first = true;
  for (const property of PROPERTIES) {
    if (!first) await new Promise((res) => setTimeout(res, 1_300)); // tile server throttles bursts
    first = false;
    let rawMean: number | null = null;
    // widen only when the inner box is genuinely empty (all-nodata cells);
    // transient transport errors retry at the same extent first.
    const attempts: Array<{ half: number; retry: boolean }> = [
      { half: 1500, retry: false },
      { half: 1500, retry: true },
      { half: 4000, retry: false },
      { half: 8000, retry: false },
    ];
    for (const { half, retry } of attempts) {
      if (retry) await new Promise((res) => setTimeout(res, 2_000));
      try {
        rawMean = await fetchCoverageMean(property, mx, my, half);
      } catch {
        rawMean = null;
      }
      if (rawMean !== null) break;
      if (!retry) await new Promise((res) => setTimeout(res, 1_500));
    }
    if (rawMean === null) continue; // no valid model cells nearby → property omitted truthfully
    const scale = WCS_TO_REST_SCALE[property] ?? 1;
    const converted = rawMean / scale;
    const [lo, hi] = PLAUSIBLE[property] ?? [-Infinity, Infinity];
    if (!Number.isFinite(converted) || converted < lo || converted > hi) continue;
    rows.push({
      property,
      depth: "0-5cm",
      mean: Math.round(converted * 10) / 10,
      uncertainty: null,
      unit: SOIL_PROPERTY_UNITS[property] ?? "",
    });
  }
  if (rows.length === 0) {
    throw new Error("SoilGrids WCS fallback found no valid model cells near the field (ISRIC coverage gap or service unavailable)");
  }
  return rows;
}
