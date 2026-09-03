import React, { useMemo } from 'react';
import * as THREE from 'three';

interface RiskData {
  id: string;
  type: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  lat: number;
  lng: number;
}

interface RiskOverlayProps {
  risks: RiskData[];
  fieldCenter: { lat: number; lng: number };
  scale?: number;
}

export function RiskOverlay({ risks, fieldCenter, scale = 0.0001 }: RiskOverlayProps) {
  const markers = useMemo(() => {
    return risks.map(r => ({
      ...r,
      pos: [
        (r.lng - fieldCenter.lng) / scale,
        0.15,
        (r.lat - fieldCenter.lat) / scale,
      ] as [number, number, number],
      color: r.severity === 'CRITICAL' || r.severity === 'HIGH' ? '#ef4444'
        : r.severity === 'MEDIUM' ? '#eab308'
        : '#22c55e',
      radius: r.severity === 'CRITICAL' ? 0.8 : r.severity === 'HIGH' ? 0.6 : r.severity === 'MEDIUM' ? 0.4 : 0.3,
    }));
  }, [risks, fieldCenter, scale]);

  return (
    <group>
      {markers.map(m => (
        <group key={m.id} position={m.pos}>
          {/* Risk pulse ring */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
            <ringGeometry args={[m.radius * 0.8, m.radius, 24]} />
            <meshStandardMaterial
              color={m.color}
              transparent
              opacity={0.3}
              side={THREE.DoubleSide}
              emissive={m.color}
              emissiveIntensity={0.2}
            />
          </mesh>
          {/* Center marker */}
          <mesh position={[0, 0.2, 0]}>
            <coneGeometry args={[0.1, 0.25, 4]} />
            <meshStandardMaterial
              color={m.color}
              emissive={m.color}
              emissiveIntensity={0.4}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
