import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

/**
 * Digital Twin scene — spatial reconstruction of the selected real field.
 *
 * Truth rules encoded here:
 * - The ground carries a REAL basemap texture (satellite or carto) of the
 *   actual geographic area — context only, labelled as such, never presented
 *   as an acquisition.
 * - The field polygon is the user's real geometry (local ENU projection,
 *   XY-aligned with the 2D MapLibre map).
 * - The soil column is rendered as a translucent slice BELOW the surface
 *   (y=0..-D). Cutaway mode lifts the map plane so the slice is inspected.
 *   Explode separates every layer strictly along Y — XY never drifts.
 * - No DEM raster → no fabricated terrain mesh; the flat surface + reported
 *   centroid elevation is stated in the panel.
 * - Soil/root-zone/crops/sensors/water render ONLY from real state. Empty
 *   layers render an explicit NO_DATA / UNKNOWN / WAITING_FOR_DEVICE zone
 *   instead of fake content. Procedural crops are labelled MODELLED.
 * - Intelligence markers come from real engine output and are clickable.
 */

export interface TwinRing {
  ring: { x: number; z: number }[];
  outer: boolean;
}

export interface TwinAcquisition {
  id: string;
  product_id: string;
  satellite: string;
  collection: string;
  acquired_at: string;
  cloud_cover: number | null;
  resolution_m: number | null;
  processing_level: string | null;
  status: string;
  source_url: string | null;
}

export interface TwinLayerData {
  state: string;
  note: string;
  elevation_m?: number | null;
  source?: string | null;
  crop_name?: string | null;
  count?: number;
  devices?: { name: string; status: string; position?: { lat: number; lon: number } }[];
  /** Real DEM raster samples inside the field (lat/lon/elevation) — used to displace the ground surface. */
  samples?: { lat: number; lon: number; elevation_m: number }[];
  sample_count?: number | null;
  slope_degrees?: number | null;
  aspect_degrees?: number | null;
}

export interface TwinSceneInput {
  field: {
    name: string;
    area_m2: number | null;
    centroid: { lat: number; lon: number };
    polygon_local_m: TwinRing[];
    crop_name?: string | null;
  };
  layers: {
    terrain: TwinLayerData;
    soil: TwinLayerData & { properties?: { property: string; value: number | null; unit: string | null }[] };
    crop: TwinLayerData;
    water: TwinLayerData;
    sensors: TwinLayerData & { devices: { name: string; status: string }[] };
    satellite: TwinLayerData & { count: number; latest_acquisition?: string | null; acquisitions?: TwinAcquisition[] };
    weather: TwinLayerData;
  };
  intelligence: {
    risks: { id: string; risk_type: string; level: string; reason: string }[];
    anomalies: { id: string; kind: string; severity: string; description: string }[];
    investigations: { id: string; title: string; status: string }[];
  };
}

export type TwinLayers = "field" | "soil" | "roots" | "crops" | "sensors" | "satellite" | "intel";

export interface TwinSceneHandle {
  setLayerVisible: (layer: TwinLayers, visible: boolean) => void;
  setExplode: (fraction: number) => void;
  setAutoRotate: (on: boolean) => void;
  setCutaway: (on: boolean) => void;
  refreshGroundTexture: () => void;
  dispose: () => void;
}

/** A pickable marker: what the click reports back to the host UI. */
export interface TwinPick {
  kind: "layer" | "risk" | "anomaly" | "investigation" | "sensor" | "acquisition" | "field";
  id?: string;
  label: string;
  note?: string;
}

interface Pickable {
  obj: THREE.Object3D;
  pick: TwinPick;
}

interface LayerGroup {
  group: THREE.Group;
  explode: number; // metres of vertical offset at 100% explode
  surfaceObjects: THREE.Object3D[]; // parts that belong at the surface (y≈0)
  belowObjects: THREE.Object3D[]; // parts that live below the surface slice
}

// ---- display thicknesses (metres). The exploded stack exaggerates the
// vertical scale on purpose: each layer must read as a THICK, ordered slab
// (XY stays to real scale; the scene labels say DISPLAY SCALE).
const SOIL_DEPTH_M = 12; // deep translucent soil column (sub-surface slice)
const ROOT_BAND_M = 4; // root-zone band = top ROOT_BAND_M of the soil column
const PLATE_M = 1.6; // exploded chip thickness for thin surface layers
// exploded lift (group.position.y at fraction=1) per layer — cumulative so the
// slabs stack one above the other with even gaps, in a fixed order:
// field → soil → roots → crops → sensors → satellite → intel
const FIELD_LIFT = 0.4;
const SOIL_LIFT = SOIL_DEPTH_M + 8; // 20 → slab 8..20
const ROOT_LIFT = SOIL_LIFT + ROOT_BAND_M + 4; // 28 → band 24..28
const CROP_LIFT = ROOT_LIFT + ROOT_BAND_M + 3; // 35 → chip 35..36.6, plants to ~42.6
const SENSOR_LIFT = CROP_LIFT + 11; // 46 → chip 46..47.6
const SAT_LIFT = SENSOR_LIFT + 5; // 51 → chip 51..52.6
const INTEL_LIFT = SAT_LIFT + 5; // 56 → chip 56..57.6, markers to ~63
const STACK_PAN_M = 46; // how far the camera target rises at 100% explode

function localBounds(rings: TwinRing[]): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) {
    for (const p of r.ring) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

function ringShape(rings: TwinRing[]): THREE.Shape {
  const outer = rings[0];
  const shape = new THREE.Shape();
  outer.ring.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.z) : shape.lineTo(p.x, p.z)));
  for (let r = 1; r < rings.length; r++) {
    const hole = new THREE.Path();
    rings[r].ring.forEach((p, i) => (i === 0 ? hole.moveTo(p.x, p.z) : hole.lineTo(p.x, p.z)));
    shape.holes.push(hole);
  }
  return shape;
}

/**
 * Ground plane displaced from real DEM samples. Each vertex height is an
 * inverse-distance-weighted interpolation of the actual raster elevations
 * (relative to the field mean so the surface sits near y=0). Same equirectangular
 * local-metre projection as the 2D map and the twin polygon (x=east, z=south).
 * DERIVED — real elevations, interpolated surface.
 */
function buildDisplacedGround(
  extent: number,
  samples: { lat: number; lon: number; elevation_m: number }[],
  centroid: { lat: number; lon: number },
): THREE.BufferGeometry {
  const segs = 28;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((centroid.lat * Math.PI) / 180);
  const pts = samples.map((s) => ({
    x: (s.lon - centroid.lon) * mPerDegLon,
    z: (s.lat - centroid.lat) * mPerDegLat,
    e: s.elevation_m,
  }));
  const meanE = pts.length ? pts.reduce((a, p) => a + p.e, 0) / pts.length : 0;
  const idw = (x: number, z: number): number => {
    if (pts.length === 0) return 0;
    let wsum = 0;
    let esum = 0;
    for (const p of pts) {
      const d2 = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
      const w = 1 / (d2 + 1e-6);
      wsum += w;
      esum += w * p.e;
    }
    return esum / wsum - meanE;
  };
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    for (let j = 0; j <= segs; j++) {
      const x = -extent / 2 + (j / segs) * extent;
      const z = -extent / 2 + (i / segs) * extent;
      positions.push(x, idw(x, z), z);
      uvs.push(j / segs, 1 - i / segs);
    }
  }
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * (segs + 1) + j;
      const b = a + 1;
      const c = a + segs + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function randomPointsInRings(rings: TwinRing[], count: number, seed: number): { x: number; z: number }[] {
  const bb = localBounds(rings);
  const pts: { x: number; z: number }[] = [];
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const outer = rings[0].ring;
  const inside = (x: number, z: number) => {
    let hit = false;
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      const xi = outer[i].x, zi = outer[i].z, xj = outer[j].x, zj = outer[j].z;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  let guard = 0;
  while (pts.length < count && guard < count * 60) {
    const x = bb.minX + rnd() * (bb.maxX - bb.minX);
    const z = bb.minZ + rnd() * (bb.maxZ - bb.minZ);
    guard++;
    if (inside(x, z)) pts.push({ x, z });
  }
  return pts;
}

function cssLabel(text: string, color: string, opts: { size?: number; bg?: string } = {}): CSS2DObject {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.color = color;
  el.style.fontFamily = "ui-monospace, Menlo, monospace";
  el.style.fontSize = `${opts.size ?? 12}px`;
  el.style.fontWeight = "700";
  el.style.letterSpacing = "0.06em";
  el.style.background = opts.bg ?? "rgba(8,16,11,0.88)";
  el.style.border = "1px solid rgba(141,199,161,0.4)";
  el.style.borderRadius = "6px";
  el.style.padding = "2px 8px";
  el.style.pointerEvents = "none";
  el.style.whiteSpace = "nowrap";
  return new CSS2DObject(el);
}

export function buildTwinScene(
  container: HTMLElement,
  mapCanvasProvider: () => HTMLCanvasElement | null,
  twin: TwinSceneInput,
  onPick?: (pick: TwinPick) => void,
): TwinSceneHandle {
  const width = container.clientWidth || 900;
  const height = container.clientHeight || 600;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x0a120d, 1);
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = "block";
  renderer.domElement.style.cursor = "grab";

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(width, height);
  labelRenderer.domElement.style.position = "absolute";
  labelRenderer.domElement.style.top = "0";
  labelRenderer.domElement.style.left = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 8000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  // allow orbiting under the surface slice so the soil column can be inspected
  controls.maxPolarAngle = Math.PI * 0.62;

  const bb = twin.field.polygon_local_m.length > 0 ? localBounds(twin.field.polygon_local_m) : { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
  const span = Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ, 60);
  const extent = Math.max(span * 1.7, 560);

  // default oblique view that shows surface + the top of the sub-surface slice
  camera.position.set(span * 0.6, extent * 0.52, extent * 1.05);
  camera.lookAt(0, -SOIL_DEPTH_M * 0.35, 0);
  controls.target.set(0, -SOIL_DEPTH_M * 0.35, 0);

  scene.add(new THREE.HemisphereLight(0xe6f3ea, 0x0a120d, 1.3));
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.position.set(extent * 0.4, extent, extent * 0.2);
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x9fc7ff, 0.5);
  rim.position.set(-extent, extent * 0.2, -extent);
  scene.add(rim);

  // subtle grid at the surface — spatial reference, not measured data
  const grid = new THREE.GridHelper(extent * 2.4, 24, 0x1d3527, 0x14241b);
  grid.position.y = 0.01;
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.3;
  scene.add(grid);

  // ---- real basemap ground (satellite or carto context) -------------------
  // When real DEM samples exist, the ground surface is displaced with an
  // inverse-distance-weighted interpolation of those actual elevations
  // (DERIVED — interpolated from real SRTM/ASTER raster samples, never
  // fabricated relief). Otherwise the surface stays honestly flat.
  const groundGroup = new THREE.Group();
  const demSamples = twin.layers.terrain.samples ?? [];
  const groundGeo =
    demSamples.length >= 4
      ? buildDisplacedGround(extent, demSamples, twin.field.centroid)
      : new THREE.PlaneGeometry(extent, extent);
  const groundMat = new THREE.MeshBasicMaterial({ color: 0x0c1711, side: THREE.DoubleSide });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  if (demSamples.length < 4) groundMesh.rotation.x = -Math.PI / 2;
  groundMesh.position.y = 0.02;
  groundMesh.userData.pick = {
    kind: "layer",
    label: "Geographic context (basemap)",
    note:
      demSamples.length >= 4
        ? `Real basemap tiles of the actual area — context only, not an acquisition. Surface relief is interpolated from ${demSamples.length} real DEM raster samples (DERIVED).`
        : "Real basemap tiles of the actual area — context only, not an acquisition.",
  } satisfies TwinPick;
  groundGroup.add(groundMesh);
  scene.add(groundGroup);

  const contextLabel = cssLabel("SATELLITE / MAP CONTEXT", "#8fb8a4", { size: 10.5, bg: "rgba(8,16,11,0.7)" });
  contextLabel.position.set(0, 0.3, span * 0.92);
  groundGroup.add(contextLabel);
  groundGroup.userData.layerId = "context";

  // ground texture capture helpers
  const applyTexture = (canvas: HTMLCanvasElement) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    groundMat.map?.dispose();
    groundMat.map = tex;
    groundMat.needsUpdate = true;
    groundMat.color.set(0xffffff);
  };
  const sampleNow = () => {
    const canvas = mapCanvasProvider();
    if (canvas && canvas.width > 0 && canvas.height > 0) applyTexture(canvas);
  };

  // ---- layer registry (every layer separates only along +Y on explode) ------
  const layerGroups = new Map<TwinLayers, LayerGroup>();
  const pickables: Pickable[] = [];

  const setExplode = (fraction: number) => {
    for (const lg of layerGroups.values()) {
      lg.group.position.y = fraction * lg.explode;
      // chips that only exist to give a layer a thick body while stacked
      for (const c of lg.group.children) {
        if ((c as THREE.Mesh).userData.plateOnly === true) c.visible = fraction > 0.03;
      }
    }
    // pan the view up as the stack grows so layers never leave the frame
    const ty = -SOIL_DEPTH_M * 0.35 + fraction * STACK_PAN_M;
    const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
    const dist = camera.position.distanceTo(controls.target);
    controls.target.set(0, ty, 0);
    camera.position.copy(controls.target).add(dir.multiplyScalar(dist));
    camera.lookAt(controls.target);
  };
  /** Chip giving a thin surface layer a thick slab body while the stack is exploded. */
  const makePlate = (thick: number, color: number, opacity: number, alwaysVisible = false): THREE.Mesh => {
    const geo = new THREE.ExtrudeGeometry(ringShape(twin.field.polygon_local_m), { depth: thick, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // slab from y=0 up to y=+thick
    const mat = new THREE.MeshPhongMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.userData.plateOnly = !alwaysVisible; // explode-only chips appear with the stack
    m.visible = alwaysVisible;
    return m;
  };
  const makeLayer = (id: TwinLayers, explode: number): LayerGroup => {
    const g = new THREE.Group();
    scene.add(g);
    const lg: LayerGroup = { group: g, explode, surfaceObjects: [], belowObjects: [] };
    layerGroups.set(id, lg);
    return lg;
  };
  // ---- field polygon (real geometry) ----------------------------------------
  if (twin.field.polygon_local_m.length > 0) {
    const fg = makeLayer("field", FIELD_LIFT);
    const ring = twin.field.polygon_local_m[0].ring;
    const pts = ring.map((p) => new THREE.Vector3(p.x, 0.18, p.z));
    const line = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0x3fd97c, linewidth: 1 }),
    );
    line.userData.pick = { kind: "field", label: "Field boundary (real geometry)", note: `${twin.field.name} — user-supplied GeoJSON, ENU-projected.` } satisfies TwinPick;
    fg.group.add(line);
    fg.surfaceObjects.push(line);
    pickables.push({ obj: line, pick: line.userData.pick as TwinPick });

    const fill = new THREE.Mesh(
      new THREE.ShapeGeometry(ringShape(twin.field.polygon_local_m)),
      new THREE.MeshBasicMaterial({ color: 0x3fd97c, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.2;
    fill.userData.pick = line.userData.pick;
    fg.group.add(fill);
    fg.surfaceObjects.push(fill);
    pickables.push({ obj: fill, pick: fill.userData.pick as TwinPick });

    const center = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 12), new THREE.MeshBasicMaterial({ color: 0xf5b942 }));
    center.position.set(0, 0.5, 0);
    center.userData.pick = {
      kind: "field",
      label: `Field centroid (${twin.field.centroid.lat.toFixed(4)}, ${twin.field.centroid.lon.toFixed(4)})`,
      note: "Anchors the ENU projection used by both the 2D map and this 3D twin.",
    } satisfies TwinPick;
    fg.group.add(center);
    fg.surfaceObjects.push(center);
    pickables.push({ obj: center, pick: center.userData.pick as TwinPick });

    const label = cssLabel("1 · FIELD — real geometry", "#3fd97c", { size: 13 });
    label.position.set(0, 4.2, 0);
    fg.group.add(label);
    fg.surfaceObjects.push(label);
  }

  // ---- soil column: translucent slice below the surface ---------------------
  // Renders real state only: ESTIMATED (model properties) or an explicit
  // NO_DATA / provider-status zone. Never fabricates structure.
  if (twin.field.polygon_local_m.length > 0 && twin.layers.soil) {
    const lg = makeLayer("soil", SOIL_LIFT);
    const soil = twin.layers.soil;
    const hasData = !!soil.properties && soil.properties.length > 0;
    const shape = ringShape(twin.field.polygon_local_m);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: SOIL_DEPTH_M, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // extrude into +y so translate down shifts below 0
    geo.translate(0, -SOIL_DEPTH_M, 0); // slab from y=0 down to y=-SOIL_DEPTH_M

    const color = hasData ? 0xb08d57 : 0x42554b;
    const mat = new THREE.MeshPhongMaterial({
      color,
      transparent: true,
      opacity: hasData ? 0.62 : 0.34,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.pick = {
      kind: "layer",
      label: hasData ? "Soil volume — ESTIMATED (global model)" : `Soil volume — ${soil.state ?? "NO_DATA"}`,
      note: soil.note,
    } satisfies TwinPick;
    lg.group.add(mesh);
    lg.belowObjects.push(mesh);
    pickables.push({ obj: mesh, pick: mesh.userData.pick as TwinPick });

    // vertical wall edges make the slice thickness legible
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: hasData ? 0xd9b98a : 0x8fa89a, transparent: true, opacity: 0.8 }),
    );
    lg.group.add(wire);
    lg.belowObjects.push(wire);
    pickables.push({ obj: wire, pick: mesh.userData.pick as TwinPick });

    // depth ruler ticks along the side (display scale only)
    for (let d = 2; d < SOIL_DEPTH_M; d += 2) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.06, 0.06),
        new THREE.MeshBasicMaterial({ color: hasData ? 0xd9b98a : 0x8fa89a }),
      );
      tick.position.set(0, -d, 0);
      lg.group.add(tick);
      lg.belowObjects.push(tick);
    }

    const stateTag = hasData ? "SOIL — ESTIMATED (model)" : `SOIL — ${soil.state ?? "NO_DATA"}`;
    const lbl = cssLabel(`2 · ${stateTag} — DISPLAY SCALE`, hasData ? "#d9b98a" : "#9fb4c4", { size: 13 });
    lbl.position.set(0, -SOIL_DEPTH_M - 0.6, 0);
    lg.group.add(lbl);
    lg.belowObjects.push(lbl);
  }

  // ---- root-zone band: top of the soil column (separates in explode) --------
  if (twin.field.polygon_local_m.length > 0) {
    const lg = makeLayer("roots", ROOT_LIFT);
    const soilState = twin.layers.soil.state;
    const cropDeclared = !!twin.field.crop_name;
    const showBand = cropDeclared || soilState === "ESTIMATED" || true; // zone itself is a labelled band either way
    if (showBand) {
      const shape = ringShape(twin.field.polygon_local_m);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: ROOT_BAND_M, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, -ROOT_BAND_M - 0.03, 0); // sits just under the surface, above the deeper soil
      const mat = new THREE.MeshPhongMaterial({ color: 0x9c7a4a, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.pick = {
        kind: "layer",
        label: cropDeclared ? "Root zone — UNKNOWN (no probe)" : "Root zone — NO_DATA",
        note: cropDeclared
          ? `Top ${ROOT_BAND_M} m of the soil column where roots of "${twin.field.crop_name}" would be. No soil probe or root model is connected — state UNKNOWN.`
          : `Top ${ROOT_BAND_M} m of the soil column. No crop declared, no probe — state NO_DATA.`,
      } satisfies TwinPick;
      lg.group.add(mesh);
      lg.belowObjects.push(mesh);
      pickables.push({ obj: mesh, pick: mesh.userData.pick as TwinPick });
    }
    const rootLabel = cssLabel(`3 · ${cropDeclared ? "ROOT ZONE — UNKNOWN" : "ROOT ZONE — NO_DATA"}`, "#d8b26a", { size: 13 });
    rootLabel.position.set(0, -ROOT_BAND_M - 0.45, 0);
    lg.group.add(rootLabel);
    lg.belowObjects.push(rootLabel);
  }

  // ---- procedural crops (MODELLED, only when crop declared) ------------------
  if (twin.field.polygon_local_m.length > 0 && twin.field.crop_name) {
    const lg = makeLayer("crops", CROP_LIFT);
    const chip = makePlate(PLATE_M, 0x2f7d4e, 0.85, true); // always-visible stand under the plants
    chip.userData.pick = {
      kind: "layer",
      label: `Crop display plate — MODELLED (${twin.field.crop_name})`,
      note: `Procedural crop stand for "${twin.field.crop_name}" — MODELLED, never presented as measured. DISPLAY SCALE.`,
    } satisfies TwinPick;
    lg.group.add(chip);
    lg.surfaceObjects.push(chip);
    pickables.push({ obj: chip, pick: chip.userData.pick as TwinPick });
    const count = Math.min(110, Math.max(8, Math.round((twin.field.area_m2 ?? 30000) / 700)));
    const pts = randomPointsInRings(twin.field.polygon_local_m, count, 7);
    const plantMat = new THREE.MeshPhongMaterial({ color: 0x4fae5c, flatShading: true });
    const stemMat = new THREE.MeshPhongMaterial({ color: 0x3a7d46 });
    for (const p of pts) {
      const h = 3.4 + Math.abs(Math.sin(p.x * 3.7 + p.z * 1.3)) * 2.2; // display scale: taller stand
      const plant = new THREE.Group();
      const stem = new THREE.CylinderGeometry(0.16, 0.24, h * 0.55);
      const stemMesh = new THREE.Mesh(stem, stemMat);
      stemMesh.position.y = PLATE_M + h * 0.28;
      plant.add(stemMesh);
      const canopy = new THREE.ConeGeometry(1.05, h * 0.62, 7);
      const canopyMesh = new THREE.Mesh(canopy, plantMat);
      canopyMesh.position.y = PLATE_M + h * 0.78;
      canopyMesh.rotation.y = p.x;
      plant.add(canopyMesh);
      plant.position.set(p.x, 0.3, p.z);
      lg.group.add(plant);
      lg.surfaceObjects.push(plant);
    }
    const lbl = cssLabel(`4 · CROP — MODELLED (procedural ${twin.field.crop_name}) · DISPLAY SCALE`, "#7be08d", { size: 13 });
    lbl.position.set(0, PLATE_M + 8.6, 0);
    lg.group.add(lbl);
    lg.surfaceObjects.push(lbl);
  }

  // ---- sensors (only real registered devices) --------------------------------
  const sensors = twin.layers.sensors;
  if (sensors.devices.length > 0) {
    const lg = makeLayer("sensors", SENSOR_LIFT);
    const chip = makePlate(PLATE_M, 0x3a3f2c, 0.6);
    lg.group.add(chip);
    lg.surfaceObjects.push(chip);
    sensors.devices.forEach((d, i) => {
      const color = d.status === "online" ? 0x3fd97c : d.status === "error" ? 0xf0716e : 0xf5b942;
      const m = new THREE.Mesh(new THREE.SphereGeometry(2.1, 18, 18), new THREE.MeshPhongMaterial({ color, emissive: color, emissiveIntensity: 0.35 }));
      const a = (i / Math.max(sensors.devices.length, 1)) * Math.PI * 2;
      const radius = Math.min(span * 0.32, 40);
      m.position.set(Math.cos(a) * radius, PLATE_M + 1.2, Math.sin(a) * radius);
      m.userData.pick = {
        kind: "sensor",
        id: d.name,
        label: `Device: ${d.name}`,
        note: `Status ${d.status}. No telemetry recorded yet — marker shown at centroid until deployment geometry exists.`,
      } satisfies TwinPick;
      lg.group.add(m);
      lg.surfaceObjects.push(m);
      pickables.push({ obj: m, pick: m.userData.pick as TwinPick });
    });
    const lbl = cssLabel(`5 · ${sensors.state === "WAITING_FOR_DEVICE" ? "SENSOR — WAITING_FOR_DEVICE" : "SENSOR — NO_DATA"}`, "#f5b942", { size: 13 });
    lbl.position.set(0, PLATE_M + 3.2, 0);
    lg.group.add(lbl);
    lg.surfaceObjects.push(lbl);
  }

  // ---- satellite acquisitions: grounded mini-rail ---------------------------
  // Each real acquisition becomes a pickable marker on a timeline rail beside
  // the field — metadata-only, honest about raster AUTH_REQUIRED.
  const sat = twin.layers.satellite;
  const acquisitions = sat.acquisitions ?? [];
  if (sat.count && sat.count > 0) {
    const lg = makeLayer("satellite", SAT_LIFT);
    const chip = makePlate(PLATE_M, 0x14324d, 0.7);
    lg.group.add(chip);
    lg.surfaceObjects.push(chip);
    const railX = -span * 0.95;
    const railMat = new THREE.LineBasicMaterial({ color: 0x5da9f6, transparent: true, opacity: 0.55 });
    const railPts = [new THREE.Vector3(railX, PLATE_M + 0.4, -span * 0.42), new THREE.Vector3(railX, PLATE_M + 0.4, span * 0.42)];
    const rail = new THREE.Line(new THREE.BufferGeometry().setFromPoints(railPts), railMat);
    lg.group.add(rail);
    lg.surfaceObjects.push(rail);
    const n = Math.max(acquisitions.length, 1);
    acquisitions.slice(0, 24).forEach((a, i) => {
      const frac = n === 1 ? 0 : i / (n - 1);
      const z = -span * 0.42 + frac * span * 0.84;
      const cloud = a.cloud_cover ?? 0;
      const color = cloud > 70 ? 0xf58a87 : cloud > 30 ? 0xf5b942 : 0x5dd99a;
      const m = new THREE.Mesh(new THREE.SphereGeometry(cloud > 70 ? 2 : 1.7, 12, 12), new THREE.MeshBasicMaterial({ color }));
      m.position.set(railX, PLATE_M + 1.4, z);
      m.userData.pick = {
        kind: "acquisition",
        id: a.id,
        label: `${a.satellite} · ${a.acquired_at.slice(0, 10)}`,
        note: `Cloud ${cloud}% · ${a.resolution_m ?? "—"} m · ${a.collection ?? "—"}\n${a.product_id}\nRaster access: ${a.status === "auth_required" ? "AUTH_REQUIRED (Copernicus OAuth)" : a.status}`,
      } satisfies TwinPick;
      lg.group.add(m);
      lg.surfaceObjects.push(m);
      pickables.push({ obj: m, pick: m.userData.pick as TwinPick });
    });
    const lbl = cssLabel(`6 · SATELLITE — ${sat.count} acquisitions (metadata)`, "#7db9f8", { size: 13 });
    lbl.position.set(railX, PLATE_M + 3.4, 0);
    lg.group.add(lbl);
    lg.surfaceObjects.push(lbl);
  }

  // ---- intelligence markers (real engine output, clickable) ------------------
  const intel = twin.intelligence;
  const hasIntel = intel.risks.length > 0 || intel.anomalies.length > 0 || intel.investigations.length > 0;
  if (hasIntel) {
    const lg = makeLayer("intel", INTEL_LIFT);
    const chip = makePlate(PLATE_M, 0x2a2140, 0.7);
    lg.group.add(chip);
    lg.surfaceObjects.push(chip);
    const levelColor = (lv: string) => (lv === "HIGH" ? 0xf0716e : lv === "MEDIUM" ? 0xf5b942 : lv === "LOW" ? 0x3fd97c : 0xa9b8c9);
    intel.risks.forEach((r, i) => {
      const m = new THREE.Mesh(new THREE.TetrahedronGeometry(2.6), new THREE.MeshPhongMaterial({ color: levelColor(r.level), emissive: levelColor(r.level), emissiveIntensity: 0.5, flatShading: true }));
      const a = (i / Math.max(intel.risks.length, 1)) * Math.PI * 2;
      m.position.set(Math.cos(a) * span * 0.4, PLATE_M + 3.4, Math.sin(a) * span * 0.4);
      m.userData.pick = {
        kind: "risk",
        id: r.id,
        label: `RISK ${r.level} — ${r.risk_type.replace(/_/g, " ")}`,
        note: r.reason,
      } satisfies TwinPick;
      lg.group.add(m);
      lg.surfaceObjects.push(m);
      pickables.push({ obj: m, pick: m.userData.pick as TwinPick });
    });
    intel.anomalies.slice(0, 3).forEach((a, i) => {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(2.2), new THREE.MeshPhongMaterial({ color: 0xff9d5c, emissive: 0xff9d5c, emissiveIntensity: 0.4, flatShading: true }));
      m.position.set(span * (0.15 + i * 0.22), PLATE_M + 2.2, -span * 0.3);
      m.userData.pick = {
        kind: "anomaly",
        id: a.id,
        label: `ANOMALY ${a.severity ?? ""} — ${a.kind.replace(/_/g, " ")}`,
        note: a.description,
      } satisfies TwinPick;
      lg.group.add(m);
      lg.surfaceObjects.push(m);
      pickables.push({ obj: m, pick: m.userData.pick as TwinPick });
    });
    intel.investigations.slice(0, 2).forEach((inv, i) => {
      const m = new THREE.Mesh(new THREE.OctahedronGeometry(2.8), new THREE.MeshPhongMaterial({ color: 0xa78bfa, emissive: 0xa78bfa, emissiveIntensity: 0.35 }));
      m.position.set(span * (0.2 + i * 0.3), PLATE_M + 2.4, span * 0.28);
      m.userData.pick = {
        kind: "investigation",
        id: inv.id,
        label: `INVESTIGATION — ${inv.status}`,
        note: inv.title,
      } satisfies TwinPick;
      lg.group.add(m);
      lg.surfaceObjects.push(m);
      pickables.push({ obj: m, pick: m.userData.pick as TwinPick });
    });
    const legend = cssLabel("7 · INTELLIGENCE markers — real engine output · click to inspect", "#a99efb", { size: 13 });
    legend.position.set(0, PLATE_M + 1.2, span * 0.8);
    lg.group.add(legend);
    lg.surfaceObjects.push(legend);
  }

  // water layer renders nothing spatially (state conveyed in the panels) — the
  // volume is never fabricated. Only its NOT_CONFIGURED/NO_DATA state is shown.

  // ---- picking (click-to-inspect) --------------------------------------------
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hovered = new Set<THREE.Object3D>();
  const selected: { obj: THREE.Object3D; prevEmissive: number | null }[] = [];
  const interactiveObjs = () => pickables.map((p) => p.obj);

  const clearSelection = () => {
    for (const s of selected) {
      const mat = s.obj as THREE.Mesh;
      if (Array.isArray(mat.material)) {
        (mat.material as THREE.MeshPhongMaterial[]).forEach((m) => {
          if (s.prevEmissive !== null && m.emissive) m.emissive.setHex(s.prevEmissive);
        });
      } else {
        const m = mat.material as THREE.MeshPhongMaterial;
        if (m && m.emissive && s.prevEmissive !== null) m.emissive.setHex(s.prevEmissive);
      }
    }
    selected.length = 0;
  };
  const select = (obj: THREE.Object3D) => {
    clearSelection();
    const mesh = obj as THREE.Mesh;
    const prev: number | null = Array.isArray(mesh.material)
      ? ((mesh.material[0] as THREE.MeshPhongMaterial).emissive?.getHex?.() ?? null)
      : (mesh.material as THREE.MeshPhongMaterial)?.emissive?.getHex?.() ?? null;
    const setEmissive = (hex: number) => {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const pm = m as THREE.MeshPhongMaterial;
        if (pm && pm.emissive) pm.emissive.setHex(hex);
      }
    };
    if (prev !== null) setEmissive(0xffffff);
    selected.push({ obj, prevEmissive: prev });
    onPick?.(obj.userData.pick as TwinPick);
  };

  const onPointerMove = (e: MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(interactiveObjs(), false);
    const top = hits[0]?.object ?? null;
    for (const h of hovered) if (h !== top && h.userData.pick) renderer.domElement.style.cursor = "grab";
    hovered.clear();
    if (top && top.userData.pick) {
      hovered.add(top);
      renderer.domElement.style.cursor = "pointer";
    }
  };
  const onClick = (e: MouseEvent) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(interactiveObjs(), false);
    if (hits.length > 0 && hits[0].object.userData.pick) select(hits[0].object);
  };
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("click", onClick);

  // ---- cutaway: lift the map plane + grid so the soil slice is inspected -----
  const setCutaway = (on: boolean) => {
    groundMesh.visible = !on;
    grid.visible = !on;
    const soil = layerGroups.get("soil");
    if (soil) {
      const mat = (soil.group.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshPhongMaterial | undefined;
      if (mat) {
        mat.opacity = on ? 0.85 : soil.belowObjects.length > 0 && twin.layers.soil.properties?.length ? 0.62 : 0.34;
        mat.needsUpdate = true;
      }
    }
    const roots = layerGroups.get("roots");
    if (roots) {
      const mat = (roots.group.children[0] as THREE.Mesh | undefined)?.material as THREE.MeshPhongMaterial | undefined;
      if (mat) mat.opacity = on ? 0.8 : 0.5;
    }
    // move camera to a low angle when entering cutaway (preserve target)
    if (on) {
      controls.target.set(0, -SOIL_DEPTH_M * 0.5, 0);
      const dir = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
      camera.position.copy(controls.target).add(dir.multiplyScalar(extent * 1.1));
      camera.position.y = Math.max(camera.position.y, -SOIL_DEPTH_M);
    }
  };

  const initialExplode = 0;
  setExplode(initialExplode);

  // initial ground texture capture (map may still be loading → retry a few times)
  let texTries = 0;
  const texTimer = window.setInterval(() => {
    const canvas = mapCanvasProvider();
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      applyTexture(canvas);
      window.clearInterval(texTimer);
    } else if (++texTries > 60) {
      window.clearInterval(texTimer);
    }
  }, 250);

  // ---- animation loop ---------------------------------------------------------
  let raf = 0;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  };
  tick();

  const onResize = () => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  return {
    setLayerVisible: (id, visible) => {
      const g = layerGroups.get(id);
      if (g) g.group.visible = visible;
    },
    setExplode,
    setAutoRotate: (on) => {
      controls.autoRotate = on;
      controls.autoRotateSpeed = 0.7;
    },
    setCutaway,
    refreshGroundTexture: () => {
      // sample immediately, then again after short delays so tiles settle
      sampleNow();
      [300, 900, 2000, 3500].forEach((ms) => window.setTimeout(sampleNow, ms));
    },
    dispose: () => {
      cancelAnimationFrame(raf);
      window.clearInterval(texTimer);
      ro.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("click", onClick);
      clearSelection();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Line || obj instanceof THREE.LineSegments) {
          obj.geometry?.dispose?.();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          for (const mat of mats) mat?.dispose?.();
        }
      });
      groundMat.map?.dispose();
      groundMat.dispose();
      renderer.dispose();
      labelRenderer.domElement.remove();
      renderer.domElement.remove();
    },
  };
}
