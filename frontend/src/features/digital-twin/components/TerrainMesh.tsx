import React, { useMemo } from 'react';
import * as THREE from 'three';

interface TerrainMeshProps {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  elevation?: number;
}

export function TerrainMesh({ geometry, elevation = 0 }: TerrainMeshProps) {
  const mesh = useMemo(() => {
    const coords = geometry.coordinates[0];
    // Convert GeoJSON [lng,lat] to Three.js [x,z] with lat as z
    const shape = new THREE.Shape();
    const scale = 0.0001; // Scale down to manageable units
    const centerX = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const centerZ = coords.reduce((s, c) => s + c[1], 0) / coords.length;

    coords.forEach((coord, i) => {
      const x = (coord[0] - centerX) / scale;
      const z = (coord[1] - centerZ) / scale;
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    });

    const geo = new THREE.ShapeGeometry(shape);
    // rotateX(+PI/2) maps shape-Y (north, `z`) to world +Z so the terrain fill
    // is north-up and aligned with the field boundary, imagery and markers.
    geo.rotateX(Math.PI / 2);
    return geo;
  }, [geometry]);

  return (
    <mesh geometry={mesh} position={[0, elevation, 0]} receiveShadow>
      <meshStandardMaterial
        color="#92400e"
        roughness={0.9}
        metalness={0.1}
        transparent
        opacity={0.85}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
