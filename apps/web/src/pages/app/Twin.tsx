import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useApp } from "../../lib/state";
import { Badge, Card, EmptyState, Hint, ProviderBadge, Spinner, TruthBadge } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { buildTwinScene, type TwinLayers, type TwinPick, type TwinSceneInput, type TwinSceneHandle } from "../../components/twin/buildTwinScene";
import { fmtArea, fmtDate } from "../../lib/format";
import type { FieldRecord } from "../../lib/types";

/** Real public satellite/aerial basemap tiles (ESRI World Imagery) — geographic context, not an acquisition. */
const SAT_STYLE = {
  version: 8,
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [{ id: "esri", type: "raster", source: "esri" }],
};
const DARK_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
type ContextStyle = "sat" | "dark";

interface TwinEnvelope {
  field: TwinSceneInput["field"] & {
    id: string;
    farm: string | null;
    crop_name: string | null;
    truth_note?: string;
  };
  layers: TwinSceneInput["layers"] & { soil: TwinSceneInput["layers"]["soil"] & { provider_status?: string } };
  intelligence: TwinSceneInput["intelligence"];
  world_model: { trigger: string; created_at: string } | null;
  xy_alignment_note?: string;
}

const LAYER_META: { id: TwinLayers; label: string }[] = [
  { id: "field", label: "Field geometry" },
  { id: "soil", label: "Soil volume" },
  { id: "roots", label: "Root zone" },
  { id: "crops", label: "Crop (MODELLED)" },
  { id: "sensors", label: "Sensors" },
  { id: "satellite", label: "Satellite" },
  { id: "intel", label: "Intelligence" },
];

const PROVIDERISH = [
  "AVAILABLE", "NO_DATA", "AUTH_REQUIRED", "NOT_CONFIGURED", "RATE_LIMITED", "TIMEOUT",
  "PROVIDER_ERROR", "UNAVAILABLE", "DATA_QUALITY_FAILURE", "WAITING_FOR_DEVICE",
];

function makeFieldMap(container: HTMLElement, field: FieldRecord, context: ContextStyle): maplibregl.Map {
  const m = new maplibregl.Map({
    container,
    style: context === "sat" ? (SAT_STYLE as never) : DARK_STYLE,
    center: [field.centroid_lon, field.centroid_lat],
    zoom: 15,
    attributionControl: { compact: true },
    canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
  });
  m.addControl(new maplibregl.NavigationControl({}), "top-left");
  m.on("load", () => {
    const b = field.bbox;
    m.fitBounds([[b.min_lon, b.min_lat], [b.max_lon, b.max_lat]], { padding: 60, duration: 0 });
  });
  return m;
}

/** Call after a map (re)loads so the 3D ground picks up the fresh canvas. */
function scheduleTextureRefresh(m: maplibregl.Map, cb: () => void): void {
  m.once("load", () => {
    cb();
    [350, 1000, 2200, 3800].forEach((ms) => window.setTimeout(cb, ms));
  });
  window.setTimeout(cb, 400);
}

export default function Twin() {
  return (
    <RequireField>
      <TwinInner />
    </RequireField>
  );
}

function TwinInner() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const mountRef = useRef<HTMLDivElement>(null);
  const hiddenMapHost = useRef<HTMLDivElement>(null);
  const splitMapHost = useRef<HTMLDivElement>(null);
  const hiddenMap = useRef<maplibregl.Map | null>(null);
  const splitMap = useRef<maplibregl.Map | null>(null);
  const handleRef = useRef<TwinSceneHandle | null>(null);
  const [twin, setTwin] = useState<TwinEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [split, setSplit] = useState(params.get("split") === "1");
  const [cinema, setCinema] = useState(false);
  const [explode, setExplode] = useState(45); // start partially exploded so the layer stack reads immediately
  const [autoRotate, setAutoRotate] = useState(false);
  const [context, setContext] = useState<ContextStyle>("sat");
  const [cutaway, setCutaway] = useState(false);
  const [selection, setSelection] = useState<TwinPick | null>(null);
  const [visible, setVisible] = useState<Record<TwinLayers, boolean>>({
    field: true,
    soil: true,
    roots: true,
    crops: true,
    sensors: true,
    satellite: true,
    intel: true,
  });

  // offscreen real map → ground texture source (always mounted). Rebuilt when
  // the field or the context basemap (satellite/dark) changes.
  useEffect(() => {
    if (!hiddenMapHost.current) return;
    const m = makeFieldMap(hiddenMapHost.current, field, context);
    hiddenMap.current = m;
    scheduleTextureRefresh(m, () => handleRef.current?.refreshGroundTexture());
    return () => {
      m.remove();
      hiddenMap.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, context]);

  // split-mode live 2D map (mounted only while split is on)
  useEffect(() => {
    if (!split || !splitMapHost.current) return;
    const m = makeFieldMap(splitMapHost.current, field, context);
    splitMap.current = m;
    return () => {
      m.remove();
      splitMap.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, field.id, context]);

  const mapCanvasProvider = useCallback(
    () => splitMap.current?.getCanvas() ?? hiddenMap.current?.getCanvas() ?? null,
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setTwin(null);
    void fetch(`/api/fields/${field.id}/digital-twin`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("agrifur_token") ?? ""}` },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Digital twin request failed (${r.status})`);
        return r.json() as Promise<{ twin: TwinEnvelope }>;
      })
      .then((d) => {
        if (cancelled) return;
        setTwin(d.twin);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load twin data");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [field.id, refreshToken]);

  useEffect(() => {
    if (!twin || !mountRef.current) return;
    const handle = buildTwinScene(mountRef.current, mapCanvasProvider, twin, (pick) => setSelection(pick));
    handleRef.current = handle;
    handle.setExplode(explode / 100); // carry the current stack state into the fresh scene
    handle.setCutaway(cutaway);
    for (const [k, v] of Object.entries(visible)) handle.setLayerVisible(k as TwinLayers, v);
    return () => {
      handle.dispose();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [twin]);

  useEffect(() => {
    handleRef.current?.setExplode(explode / 100);
  }, [explode]);
  useEffect(() => {
    handleRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);
  useEffect(() => {
    handleRef.current?.setCutaway(cutaway);
  }, [cutaway]);
  useEffect(() => {
    for (const [k, v] of Object.entries(visible)) handleRef.current?.setLayerVisible(k as TwinLayers, v);
  }, [visible]);

  const setSplitMode = (s: boolean) => {
    setSplit(s);
    if (s) setParams({ split: "1" });
    else setParams({});
  };

  const layers = twin?.layers;
  const canvasHeight = cinema ? "calc(100dvh - 18px)" : "calc(100vh - 178px)";

  return (
    <div className="page" style={{ maxWidth: 1700, paddingBottom: 0 }}>
      <div className="page-head" style={cinema ? { display: "none" } : undefined}>
        <div>
          <div className="page-title">Digital Twin — {field.name}</div>
          <div className="page-sub">
            3D spatial representation of the farm world model — same geometry as the 2D map (local ENU projection,
            XY-aligned). Explode separates layers only vertically. Every layer shows its true state.
          </div>
        </div>
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <div className="row" style={{ gap: 4, border: "1px solid var(--border-strong)", borderRadius: 10, padding: 3 }}>
            <Link to="/app" className="btn btn-sm btn-ghost">2D</Link>
            <button className="btn btn-sm btn-primary" type="button">3D</button>
            <button className={`btn btn-sm ${split ? "btn-primary" : "btn-ghost"}`} onClick={() => setSplitMode(!split)} type="button">Split</button>
          </div>
          <div className="row" style={{ gap: 4, border: "1px solid var(--border-strong)", borderRadius: 10, padding: 3 }}>
            <button className={`btn btn-sm ${context === "sat" ? "btn-primary" : "btn-ghost"}`} onClick={() => setContext("sat")} type="button">🛰️ Satellite context</button>
            <button className={`btn btn-sm ${context === "dark" ? "btn-primary" : "btn-ghost"}`} onClick={() => setContext("dark")} type="button">🗺️ Map context</button>
          </div>
          <button className={`btn btn-sm ${cutaway ? "btn-primary" : ""}`} onClick={() => setCutaway((c) => !c)} type="button" title="Reveals the soil/root slice under the surface">
            {cutaway ? "◧ Cutaway on" : "◈ Soil cutaway"}
          </button>
          <button className={`btn btn-sm ${autoRotate ? "btn-primary" : ""}`} onClick={() => setAutoRotate((a) => !a)} type="button">
            {autoRotate ? "⏸ Orbit" : "▶ Orbit"}
          </button>
          <button className="btn btn-sm" onClick={() => { setExplode(0); setCutaway(false); }} type="button">Reset</button>
          <button className={`btn btn-sm ${cinema ? "btn-primary" : ""}`} onClick={() => setCinema((c) => !c)} type="button" title="Fill the whole screen with the 3D scene">
            {cinema ? "✕ Exit full scene" : "⛶ Full scene"}
          </button>
        </div>
      </div>

      {loading && <Spinner label="Composing digital twin…" />}
      {err && !loading && (
        <EmptyState emoji="🧊" title="Twin unavailable" body={err} />
      )}
      {!loading && !err && !twin && (
        <EmptyState emoji="🧊" title="No twin data" body="Run the field pipeline (analyze or refresh) first, then reopen this workspace." />
      )}

      {twin && (
        <div
          className="grid"
          style={{
            gridTemplateColumns: cinema ? "1fr" : split ? "minmax(320px, 1fr) minmax(420px, 1fr)" : "330px minmax(420px, 1fr)",
            alignItems: "start",
          }}
        >
          <div className="col" style={cinema ? { display: "none" } : { gap: 10, maxHeight: "calc(100vh - 190px)", overflowY: "auto", paddingRight: 2 }}>
            <Card title="Scene controls">
              <div className="col" style={{ gap: 8 }}>
                <div className="section-label">Explode layers (vertical only)</div>
                <div className="faint" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
                  Thick layer slabs, one above the other: 1 field → 2 soil → 3 roots → 4 crops → 5 sensors → 6 satellite →
                  7 intelligence. Vertical scale is exaggerated (DISPLAY SCALE) so every layer reads clearly; XY stays true
                  to the real field geometry.
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={explode}
                  onChange={(e) => setExplode(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "var(--accent)" }}
                  aria-label="Explode layers"
                />
                <div className="faint mono" style={{ fontSize: 11.5 }}>{explode}%</div>
                <div className="col" style={{ gap: 3 }}>
                  {LAYER_META.map((l) => (
                    <label key={l.id} className="row" style={{ gap: 8, cursor: "pointer", fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={visible[l.id]}
                        onChange={(e) => setVisible((v) => ({ ...v, [l.id]: e.target.checked }))}
                        style={{ accentColor: "var(--accent)" }}
                      />
                      {l.label}
                    </label>
                  ))}
                </div>
              </div>
            </Card>

            {selection && (
              <Card title="Inspection" right={<button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelection(null)}>✕</button>}>
                <div style={{ fontSize: 13.5, fontWeight: 650, marginBottom: 6 }}>{selection.label}</div>
                {selection.note && (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, fontFamily: "inherit", margin: 0, lineHeight: 1.55 }}>{selection.note}</pre>
                )}
                {selection.kind === "acquisition" && (
                  <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
                    Acquisition metadata from Copernicus STAC · raster preview requires Copernicus OAuth (AUTH_REQUIRED).
                  </div>
                )}
              </Card>
            )}

            <Card title="Field">
              <div className="kv" style={{ gridTemplateColumns: "90px 1fr", fontSize: 12.5 }}>
                <dt>name</dt><dd>{twin.field.name}</dd>
                <dt>farm</dt><dd>{twin.field.farm ?? "—"}</dd>
                <dt>area</dt><dd>{fmtArea(twin.field.area_m2)}</dd>
                <dt>vertices</dt><dd className="mono">{twin.field.polygon_local_m[0]?.ring.length ?? 0}</dd>
              </div>
              {twin.field.truth_note && <div className="hint mt-8">{twin.field.truth_note}</div>}
            </Card>

            {layers && (
              <LayerStateCard
                title="Terrain"
                state={layers.terrain.state}
                note={layers.terrain.note}
                extra={
                  layers.terrain.elevation_m != null
                    ? layers.terrain.samples && layers.terrain.samples.length >= 4
                      ? `mean ${layers.terrain.elevation_m} m over ${layers.terrain.samples.length} real DEM samples (DERIVED)${layers.terrain.slope_degrees != null ? ` · slope ${layers.terrain.slope_degrees}°` : ""}`
                      : `elevation ${layers.terrain.elevation_m} m (centroid point, DERIVED)`
                    : undefined
                }
              />
            )}
            {layers && (
              <LayerStateCard
                title="Soil"
                state={layers.soil.state === "NO_DATA" && layers.soil.provider_status ? layers.soil.provider_status : layers.soil.state}
                note={layers.soil.note}
                extra={layers.soil.properties?.length ? `${layers.soil.properties.length} model properties (ESTIMATED)` : undefined}
              />
            )}
            {layers && <LayerStateCard title="Crop" state={layers.crop.state} note={layers.crop.note} extra={layers.crop.crop_name ? `declared: ${layers.crop.crop_name}` : undefined} />}
            {layers && <LayerStateCard title="Water" state={layers.water.state} note={layers.water.note} />}
            {layers && <LayerStateCard title="Sensors" state={layers.sensors.state} note={layers.sensors.note} />}
            {layers && <LayerStateCard title="Satellite" state={layers.satellite.state} note={layers.satellite.note} extra={layers.satellite.count ? `${layers.satellite.count} real acquisitions` : undefined} />}

            {twin.xy_alignment_note && <Hint>{twin.xy_alignment_note}</Hint>}
            <Hint warn>
              Truth labels in the scene are authoritative: green = field geometry · amber = registered-but-idle
              hardware · procedural crop/plant shapes are <Badge className="ts-SIMULATED">MODELLED</Badge> and never
              presented as measured.
            </Hint>
          </div>

          <div className="grid" style={{ gridTemplateColumns: split ? "1fr 1fr" : "1fr", gap: 12, minWidth: 0 }}>
            {split && !cinema && (
              <div className="map-wrap" style={{ height: canvasHeight, minHeight: 520 }}>
                <div ref={splitMapHost} style={{ position: "absolute", inset: 0 }} />
                <div className="map-legend" style={{ bottom: "auto", top: 10 }}>
                  <span className="faint" style={{ fontSize: 11.5 }}>
                    2D — same field geometry · {context === "sat" ? "real satellite/aerial context" : "map context"}
                  </span>
                </div>
              </div>
            )}
            <div className="map-wrap" style={{ height: canvasHeight, minHeight: cinema ? 600 : 520 }}>
              <div ref={mountRef} style={{ position: "absolute", inset: 0 }} />
              {cinema && (
                <div className="map-legend" style={{ bottom: "auto", top: 10, left: 10 }}>
                  <button className="btn btn-sm" onClick={() => setCinema(false)} type="button">✕ Exit full scene</button>
                </div>
              )}
              <div className="map-legend" style={{ bottom: "auto", top: 10, right: 10, left: "auto" }}>
                <span className="faint" style={{ fontSize: 11.5 }}>
                  {context === "sat"
                    ? "3D — ground textured with real satellite/aerial imagery (context, not an acquisition)"
                    : "3D — ground textured from the same map context"}
                </span>
              </div>
              {twin.intelligence.risks.length > 0 && (
                <div className="map-legend">
                  <div className="section-label" style={{ marginBottom: 4 }}>Risk markers (real engine output)</div>
                  {twin.intelligence.risks.slice(0, 4).map((r) => (
                    <div key={r.id} className="row" style={{ gap: 5, fontSize: 11.5, margin: "2px 0" }}>
                      <Badge className={`rl-${r.level}`} style={{ fontSize: 10 }}>{r.level}</Badge>
                      <span style={{ textTransform: "capitalize" }}>{r.risk_type.replace(/_/g, " ")}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {twin && !cinema && (twin.layers.satellite.acquisitions?.length ?? 0) > 0 && (
        <Card className="mt-12" title={`Satellite acquisition timeline — ${twin.layers.satellite.acquisitions?.length ?? 0} real STAC products`}>
          <div className="row" style={{ gap: 8, overflowX: "auto", paddingBottom: 4 }}>
            {(twin.layers.satellite.acquisitions ?? []).map((a) => (
              <button
                key={a.id}
                type="button"
                className="btn btn-sm"
                style={{ flexDirection: "column", alignItems: "flex-start", gap: 2, whiteSpace: "nowrap" }}
                onClick={() => setSelection({ kind: "acquisition", id: a.id, label: `${a.satellite} · ${fmtDate(a.acquired_at)}`, note: `Cloud ${a.cloud_cover ?? "—"}% · ${a.resolution_m ?? "—"} m · ${a.collection ?? "—"}\n${a.product_id}\nRaster access: ${a.status === "auth_required" ? "AUTH_REQUIRED (Copernicus OAuth)" : a.status}` })}
              >
                <span className="row" style={{ gap: 6 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      display: "inline-block",
                      background: (a.cloud_cover ?? 0) > 70 ? "#f58a87" : (a.cloud_cover ?? 0) > 30 ? "#f5b942" : "#5dd99a",
                    }}
                  />
                  <span style={{ fontSize: 11.5, fontWeight: 600 }}>{a.satellite}</span>
                </span>
                <span className="faint mono" style={{ fontSize: 10.5 }}>{fmtDate(a.acquired_at)} · ☁ {a.cloud_cover ?? "—"}%</span>
              </button>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
            Real acquisitions over this field's AOI (Copernicus STAC). Selecting one opens its metadata in the inspection
            panel — metadata is real; raster/preview access is AUTH_REQUIRED until Copernicus OAuth is configured.
          </div>
        </Card>
      )}

      {/* offscreen real basemap → ground texture (always mounted) */}
      <div
        ref={hiddenMapHost}
        aria-hidden
        style={{
          position: "fixed",
          left: -10000,
          top: 0,
          width: 900,
          height: 900,
          opacity: 0.01,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function LayerStateCard({ title, state, note, extra }: { title: string; state: string; note?: string; extra?: string }) {
  return (
    <Card title={title}>
      <div className="row" style={{ gap: 5 }}>
        {PROVIDERISH.includes(state) ? (
          <ProviderBadge state={state} />
        ) : (
          <TruthBadge state={state as never} />
        )}
        {extra && <span className="faint mono" style={{ fontSize: 11 }}>{extra}</span>}
      </div>
      {note && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>{note}</div>}
    </Card>
  );
}