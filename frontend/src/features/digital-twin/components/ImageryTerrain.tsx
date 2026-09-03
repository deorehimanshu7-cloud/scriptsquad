import React, { useMemo, useState, useEffect } from 'react';
import * as THREE from 'three';

/**
 * REAL imagery base for the Digital Twin.
 *
 * A single real satellite/aerial tile (Esri World Imagery, public REST
 * endpoint with CORS) covering the field bounding box is placed in the scene
 * with the SAME degree→scene transform every other layer uses, so the imagery,
 * the field boundary, sensors and crops stay geographically aligned.
 *
 * Truth rules:
 *  - The tile is real geographic imagery (OBSERVED), never a generated
 *    texture. Attribution: Esri, Maxar, Earthstar Geographics and the GIS
 *    User Community (shown in the Twin info card while AVAILABLE).
 *  - If the tile cannot be fetched (offline / CORS), nothing is rendered and
 *    the parent is told `UNAVAILABLE` — the scene never substitutes a fake
 *    image. The relief-coloured TerrainMesh beneath remains visible.
 */

export type ImageryStatus = 'LOADING' | 'AVAILABLE' | 'UNAVAILABLE';

interface ImageryTerrainProps {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  scale?: number;
  onStatus?: (status: ImageryStatus) => void;
}

const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Web-Mercator row → latitude (degrees) for a given zoom row. */
function latFromRow(y: number, n: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
}

interface Tile {
  z: number;
  x: number;
  y: number;
  lng0: number;
  lng1: number;
  lat0: number; // south
  lat1: number; // north
}

function pickTile(bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number }): Tile {
  const spanLng = Math.max(bbox.maxLng - bbox.minLng, 1e-6);
  const spanLat = Math.max(bbox.maxLat - bbox.minLat, 1e-6);
  const cLng = (bbox.minLng + bbox.maxLng) / 2;
  const cLat = (bbox.minLat + bbox.maxLat) / 2;

  // Aim for the field to occupy roughly 24–90 px within a 256 px tile, then
  // verify the chosen tile actually contains the whole AOI.
  let z = clamp(Math.ceil(Math.log2(360 / (spanLng * (256 / 56)))), 10, 18);
  for (; z <= 18; z++) {
    const n = 2 ** z;
    let x = clamp(Math.floor(((cLng + 180) / 360) * n), 0, n - 1);
    const latRad = (cLat * Math.PI) / 180;
    let y = clamp(Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n), 0, n - 1);

    // Shift the tile by whole tiles if the AOI crosses a tile edge.
    for (let guard = 0; guard < 4; guard++) {
      const lng0 = (x / n) * 360 - 180;
      const lng1 = ((x + 1) / n) * 360 - 180;
      const lat0 = latFromRow(y + 1, n);
      const lat1 = latFromRow(y, n);
      if (lng0 <= bbox.minLng && lng1 >= bbox.maxLng && lat0 <= bbox.minLat && lat1 >= bbox.maxLat) {
        return { z, x, y, lng0, lng1, lat0, lat1 };
      }
      if (bbox.minLng < lng0) x -= 1;
      else if (bbox.maxLng > lng1) x += 1;
      else if (bbox.minLat < lat0) y += 1;
      else if (bbox.maxLat > lat1) y -= 1;
      else break;
      x = clamp(x, 0, n - 1);
      y = clamp(y, 0, n - 1);
    }
  }
  // Very large AOI: fall back to the centroid tile at z=14 (partial coverage is
  // still real imagery and never mislabeled as full coverage).
  const z2 = 14;
  const n2 = 2 ** z2;
  const x2 = clamp(Math.floor(((cLng + 180) / 360) * n2), 0, n2 - 1);
  const latRad2 = (cLat * Math.PI) / 180;
  const y2 = clamp(Math.floor(((1 - Math.asinh(Math.tan(latRad2)) / Math.PI) / 2) * n2), 0, n2 - 1);
  return {
    z: z2, x: x2, y: y2,
    lng0: (x2 / n2) * 360 - 180,
    lng1: ((x2 + 1) / n2) * 360 - 180,
    lat0: latFromRow(y2 + 1, n2),
    lat1: latFromRow(y2, n2),
  };
}

export function ImageryTerrain({ geometry, scale = 0.0001, onStatus }: ImageryTerrainProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [failed, setFailed] = useState(false);

  const coords = geometry.coordinates[0];
  const plane = useMemo(() => {
    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    for (const c of coords) {
      minLng = Math.min(minLng, c[0]); maxLng = Math.max(maxLng, c[0]);
      minLat = Math.min(minLat, c[1]); maxLat = Math.max(maxLat, c[1]);
    }
    const centerLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const centerLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    const tile = pickTile({ minLng, minLat, maxLng, maxLat });

    const wx = (lng: number) => (lng - centerLng) / scale;
    const wz = (lat: number) => (lat - centerLat) / scale;

    const geometryData = new THREE.BufferGeometry();
    // SW, SE, NE, NW in world (x, z) with matching UVs (0,0)=(south-west).
    const positions = new Float32Array([
      wx(tile.lng0), 0.004, wz(tile.lat0),
      wx(tile.lng1), 0.004, wz(tile.lat0),
      wx(tile.lng1), 0.004, wz(tile.lat1),
      wx(tile.lng0), 0.004, wz(tile.lat1),
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const index = new Uint16Array([0, 1, 2, 0, 2, 3]);
    geometryData.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometryData.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometryData.setIndex(new THREE.BufferAttribute(index, 1));
    geometryData.computeVertexNormals();
    return { geometryData, url: `${TILE_URL}/${tile.z}/${tile.y}/${tile.x}` };
  }, [coords, scale]);

  useEffect(() => {
    let alive = true;
    setImage(null);
    setFailed(false);
    onStatus?.('LOADING');
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (alive) { setImage(img); onStatus?.('AVAILABLE'); }
    };
    img.onerror = () => {
      if (alive) { setFailed(true); onStatus?.('UNAVAILABLE'); }
    };
    img.src = plane.url;
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plane.url]);

  const texture = useMemo(() => {
    if (!image) return null;
    const tex = new THREE.CanvasTexture(image);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }, [image]);

  if (!image || failed) return null;

  return (
    <mesh geometry={plane.geometryData} receiveShadow>
      <meshStandardMaterial map={texture} roughness={1} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}
