import React, { useMemo } from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';

interface FieldBoundaryProps {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  color?: string;
}

export function FieldBoundary({ geometry, color = '#22c55e' }: FieldBoundaryProps) {
  const points = useMemo(() => {
    const coords = geometry.coordinates[0];
    const scale = 0.0001;
    const centerX = coords.reduce((s, c) => s + c[0], 0) / coords.length;
    const centerZ = coords.reduce((s, c) => s + c[1], 0) / coords.length;
    return coords.map(c => [
      (c[0] - centerX) / scale,
      0.05,
      (c[1] - centerZ) / scale,
    ] as [number, number, number]);
  }, [geometry]);

  return <Line points={points} color={color} lineWidth={3} />;
}
