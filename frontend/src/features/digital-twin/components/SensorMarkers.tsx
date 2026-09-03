import React, { useMemo } from 'react';

interface SensorData {
  id: string;
  type: string;
  lat: number;
  lng: number;
  status: 'active' | 'inactive' | 'error';
}

interface SensorMarkersProps {
  sensors: SensorData[];
  fieldCenter: { lat: number; lng: number };
  scale?: number;
}

export function SensorMarkers({ sensors, fieldCenter, scale = 0.0001 }: SensorMarkersProps) {
  const markers = useMemo(() => {
    return sensors.map(s => ({
      ...s,
      pos: [
        (s.lng - fieldCenter.lng) / scale,
        0.3,
        (s.lat - fieldCenter.lat) / scale,
      ] as [number, number, number],
      color: s.status === 'active' ? '#06b6d4' : s.status === 'error' ? '#ef4444' : '#64748b',
    }));
  }, [sensors, fieldCenter, scale]);

  return (
    <group>
      {markers.map(m => (
        <group key={m.id} position={m.pos}>
          {/* Antenna pole */}
          <mesh position={[0, 0.3, 0]}>
            <cylinderGeometry args={[0.015, 0.015, 0.6, 6]} />
            <meshStandardMaterial color="#475569" metalness={0.6} />
          </mesh>
          {/* Status light */}
          <mesh position={[0, 0.65, 0]}>
            <sphereGeometry args={[0.06, 8, 8]} />
            <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.5} />
          </mesh>
          {/* Base */}
          <mesh position={[0, 0.02, 0]}>
            <boxGeometry args={[0.15, 0.04, 0.15]} />
            <meshStandardMaterial color="#334155" metalness={0.4} />
          </mesh>
        </group>
      ))}
    </group>
  );
}
