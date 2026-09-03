import React, { useMemo } from 'react';
import * as THREE from 'three';

/**
 * MODELLED crop visualization only — never agricultural data.
 * Plants are decorative geometry (random placement/size/colour inside the
 * field bounds) because no real 3D crop observations exist. The UI labels the
 * layer MODELLED; nothing here feeds evidence or the World Model.
 */
interface CropLayerProps {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  density?: number;
}

export function CropLayer({ geometry, density = 50 }: CropLayerProps) {
  const plants = useMemo(() => {
    const coords = geometry.coordinates[0];
    const scale = 0.0001;
    const centerX = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const centerZ = coords.reduce((s, c) => s + c[1], 0) / coords.length;

    // Simple polygon bounds for random point placement
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    coords.forEach(c => {
      const x = (c[0] - centerX) / scale;
      const z = (c[1] - centerZ) / scale;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    });

    const result: { pos: [number, number, number]; scale: number; color: string }[] = [];
    for (let i = 0; i < density; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      const s = 0.3 + Math.random() * 0.4;
      // Vary green slightly per plant
      const g = 0.5 + Math.random() * 0.3;
      const color = new THREE.Color(0.1, g, 0.15).getStyle();
      result.push({ pos: [x, s * 0.5, z], scale: s, color });
    }
    return result;
  }, [geometry, density]);

  return (
    <group>
      {plants.map((p, i) => (
        <group key={i} position={p.pos}>
          {/* Stem */}
          <mesh position={[0, p.scale * 0.25, 0]}>
            <cylinderGeometry args={[0.02, 0.03, p.scale * 0.5, 4]} />
            <meshStandardMaterial color="#166534" roughness={0.8} />
          </mesh>
          {/* Crown */}
          <mesh position={[0, p.scale * 0.55, 0]}>
            <sphereGeometry args={[p.scale * 0.2, 6, 4]} />
            <meshStandardMaterial color={p.color} roughness={0.7} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
