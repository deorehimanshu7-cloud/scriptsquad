import React, { useRef, useMemo, useEffect } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Grid } from '@react-three/drei';
import { TerrainMesh } from './TerrainMesh';
import { ImageryTerrain, ImageryStatus } from './ImageryTerrain';
import { SubSurfaceBands } from './SubSurfaceBands';
import { FieldBoundary } from './FieldBoundary';
import { CropLayer } from './CropLayer';
import { SensorMarkers } from './SensorMarkers';
import { RiskOverlay } from './RiskOverlay';

interface DigitalTwinSceneProps {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  centroid: { coordinates: [number, number] };
  layers: {
    terrain: boolean;
    crop: boolean;
    sensors: boolean;
    risk: boolean;
    anomaly: boolean;
    evidence: boolean;
    water: boolean;
    soil: boolean;
    rootZone: boolean;
  };
  explodeFactor: number;
  sensors?: { id: string; type: string; lat: number; lng: number; status: 'active' | 'inactive' | 'error' }[];
  risks?: { id: string; type: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; lat: number; lng: number }[];
  onImageryStatus?: (status: ImageryStatus) => void;
  /** Raise to fly the camera: 'field' frames the field, 'world' zooms out to the full geographic context. */
  viewRequest?: { target: 'field' | 'world'; ts: number } | null;
}

function CameraFollower({ sceneSize, request }: { sceneSize: number; request?: { target: 'field' | 'world'; ts: number } | null }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    if (!request) return;
    const dist = request.target === 'field' ? sceneSize * 1.05 : sceneSize * 4;
    const pitch = request.target === 'field' ? 0.62 : 0.72;
    camera.position.set(Math.sin(0.9) * dist * Math.cos(pitch), dist * Math.sin(pitch) + sceneSize * 0.12, Math.cos(0.9) * dist * Math.cos(pitch));
    const ctl = controls as any;
    if (ctl && typeof ctl.target?.set === 'function') {
      ctl.target.set(0, 0, 0);
      ctl.update();
    }
    camera.lookAt(0, 0, 0);
  }, [request?.ts]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

export function DigitalTwinScene({ geometry, centroid, layers, explodeFactor, sensors = [], risks = [], onImageryStatus, viewRequest }: DigitalTwinSceneProps) {
  const groupRef = useRef<any>(null);

  const fieldCenter = { lat: centroid.coordinates[1], lng: centroid.coordinates[0] };

  // Camera framing is derived from the REAL field extent so the whole
  // geographic context is visible (zoom out) while the field still fills the
  // initial view — the scene never looks like a fixed toy box.
  const extent = useMemo(() => {
    const coords = geometry.coordinates[0];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of coords) {
      minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]);
      minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
    }
    return { w: (maxX - minX) / 0.0001, h: (maxY - minY) / 0.0001 };
  }, [geometry]);
  const sceneSize = Math.max(extent.w, extent.h, 8);
  const camDist = sceneSize * 1.15;

  return (
    <Canvas shadows>
      {/* Bright agricultural scene sky */}
      <color attach="background" args={['#e3eee2']} />
      <PerspectiveCamera makeDefault position={[camDist * 0.6, camDist * 0.85, camDist * 0.85]} fov={45} />
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        minDistance={Math.max(0.8, sceneSize / 90)}
        maxDistance={sceneSize * 4.2}
        maxPolarAngle={Math.PI / 2.05}
      />
      <CameraFollower sceneSize={sceneSize} request={viewRequest} />

      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight
        position={[10, 15, 10]}
        intensity={1.2}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />
      <hemisphereLight color="#87ceeb" groundColor="#92400e" intensity={0.3} />

      {/* Scene layers with explode */}
      <group ref={groupRef}>
        {/* Terrain (always at bottom): relief-coloured fallback + REAL imagery
          tile (Esri World Imagery) aligned to the same field transform when a
          tile loads. If imagery is unavailable the relief mesh stays — no fake
          texture is ever substituted. */}
        {layers.terrain && (
          <>
            <TerrainMesh geometry={geometry} elevation={0} />
            <ImageryTerrain geometry={geometry} onStatus={onImageryStatus} />
          </>
        )}

        {/* MODELLED sub-surface cutaway: thick soil / root-zone / water slabs
          geographically aligned under the field. Pure visualization — never
          claimed as measured geometry. Explode opens the vertical stack while
          every band keeps its field X/Z position. */}
        <SubSurfaceBands
          geometry={geometry}
          explode={explodeFactor}
          active={{ soil: layers.soil, rootZone: layers.rootZone, water: layers.water }}
        />

        {/* Field boundary */}
        <FieldBoundary geometry={geometry} />

        {/* Crop layer (modelled) */}
        {layers.crop && (
          <group position={[0, 0.5 + 0.2 * explodeFactor, 0]}>
            <CropLayer geometry={geometry} density={60} />
          </group>
        )}

        {/* Sensors */}
        {layers.sensors && sensors.length > 0 && (
          <group position={[0, 0.8 + 0.3 * explodeFactor, 0]}>
            <SensorMarkers sensors={sensors} fieldCenter={fieldCenter} />
          </group>
        )}

        {/* Risk overlay */}
        {layers.risk && risks.length > 0 && (
          <group position={[0, 1.0 + 0.4 * explodeFactor, 0]}>
            <RiskOverlay risks={risks} fieldCenter={fieldCenter} />
          </group>
        )}
      </group>

      {/* Ground grid */}
      <Grid
        position={[0, -0.01, 0]}
        args={[20, 20]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#1e293b"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#334155"
        fadeDistance={25}
        infiniteGrid
      />
    </Canvas>
  );
}
