import React, { useMemo } from 'react';
import * as THREE from 'three';

/**
 * SubSurfaceBands — thick, geographically-aligned soil / root-zone / water
 * slabs under the real field polygon.
 *
 * Truth & alignment rules:
 *  - The same GeoJSON → local transform as every other scene layer
 *    (x = (lng−cLng)/scale, z = (lat−cLat)/scale) keeps each band's X/Z
 *    exactly under the field.
 *  - Bands are VISUALIZATION (MODELLED cutaway), never claimed as measured
 *    soil/water geometry. The explode slider is a pure-Z visual offset.
 */
const SCALE = 0.0001;

function polygonPoints(geometry: { type: 'Polygon'; coordinates: number[][][] }) {
  const coords = geometry.coordinates[0];
  let cx = 0, cy = 0;
  for (const c of coords) { cx += c[0]; cy += c[1]; }
  cx /= coords.length; cy /= coords.length;
  return coords.map(c => ({ x: (c[0] - cx) / SCALE, z: (c[1] - cy) / SCALE }));
}

export interface BandSpec {
  /** relative band index — lower index sits nearer the surface */
  index: number;
  thickness: number;
  color: string;
  opacity: number;
}

function bandTop(index: number, thickness: number, explode: number): number {
  // Vertical layout: index 0 (soil) hugs the surface; each deeper band sits
  // below the previous one. Explode opens gaps (pure visual offset only).
  let cumulative = 0;
  const thicknesses = [0.5, 0.5, 0.3];
  for (let i = 0; i < index; i++) cumulative += thicknesses[i] + 0.12;
  return -(0.18 + 0.3 * explode) * (index + 1) - cumulative;
}

function BandMesh({ geometry, yTop, depth, color, opacity }: {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  yTop: number; depth: number; color: string; opacity: number;
}) {
  const mesh = useMemo(() => {
    const shape = new THREE.Shape();
    polygonPoints(geometry).forEach((p, i) => {
      if (i === 0) shape.moveTo(p.x, p.z);
      else shape.lineTo(p.x, p.z);
    });
    // Extrude along +Z then rotate X by π/2: shape-plane Y → world +Z
    // (north-up) and extrusion +Z → world −Y, so the slab grows DOWNWARD
    // from yTop, exactly aligned with the terrain/boundary transform.
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);
    geo.computeVertexNormals();
    return geo;
  }, [geometry, depth]);

  return (
    <mesh geometry={mesh} position={[0, yTop, 0]} receiveShadow>
      <meshStandardMaterial
        color={color}
        roughness={0.85}
        metalness={0.05}
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        depthWrite={false}
      />
    </mesh>
  );
}

function BandEdge({ geometry, yTop, color }: { geometry: { type: 'Polygon'; coordinates: number[][][] }; yTop: number; color: string }) {
  const line = useMemo(() => {
    const pts = polygonPoints(geometry);
    const positions = new Float32Array(pts.length * 3);
    pts.forEach((p, i) => { positions[i * 3] = p.x; positions[i * 3 + 1] = yTop; positions[i * 3 + 2] = p.z; });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, [geometry, yTop]);
  return (
    <lineLoop geometry={line}>
      <lineBasicMaterial color={color} transparent opacity={0.9} />
    </lineLoop>
  );
}

export function SubSurfaceBands({ geometry, explode, active }: {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  explode: number;
  active: { soil: boolean; rootZone: boolean; water: boolean };
}) {
  const specs: { key: keyof typeof active; color: string; opacity: number; thickness: number }[] = [
    { key: 'soil', color: '#8a5a2b', opacity: 0.5, thickness: 0.5 },
    { key: 'rootZone', color: '#6d3f1d', opacity: 0.55, thickness: 0.5 },
    { key: 'water', color: '#1d6fa5', opacity: 0.45, thickness: 0.3 },
  ];

  return (
    <group>
      {specs.map((s, idx) => {
        if (!active[s.key]) return null;
        const yTop = bandTop(idx, s.thickness, explode);
        return (
          <group key={s.key}>
            <BandMesh geometry={geometry} yTop={yTop} depth={s.thickness} color={s.color} opacity={s.opacity} />
            <BandEdge geometry={geometry} yTop={yTop} color={s.color} />
            {/* thin bright ring at the slab floor makes the band read as 3D
                when exploded, while X/Z stay field-aligned */}
            <BandEdge geometry={geometry} yTop={yTop - s.thickness} color={'#fbbf24'} />
          </group>
        );
      })}
    </group>
  );
}
