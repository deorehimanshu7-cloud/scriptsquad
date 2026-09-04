import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useApp } from "../../lib/state";
import { farmApi, toast, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, Hint } from "../../components/ui";
import { fmtArea } from "../../lib/format";
import type { FarmRecord, FieldRecord } from "../../lib/types";

/** Development-seed polygon: approximate boundary near Nashik, Maharashtra (India). */
const DEV_SEED_RING: number[][] = [
  [73.7882, 20.0001],
  [73.7891, 20.0004],
  [73.7904, 20.0005],
  [73.7916, 20.0002],
  [73.7923, 19.9993],
  [73.7918, 19.9984],
  [73.7905, 19.9981],
  [73.7892, 19.9986],
  [73.7885, 19.9994],
];

const DEFAULT_CENTER: [number, number] = [73.7903, 19.9993];
const RADIUS_OPTIONS = [100, 250, 500, 1000, 5000];

/** Circular AOI around a point (WGS84). An approximate discovery boundary — not a surveyed parcel edge. */
function circleRing(lat: number, lon: number, radiusM: number, segments = 48): number[][] {
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const dLat = radiusM / mPerDegLat;
  const dLon = radiusM / mPerDegLon;
  const pts: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push([Number((lon + dLon * Math.cos(a)).toFixed(6)), Number((lat + dLat * Math.sin(a)).toFixed(6))]);
  }
  return pts;
}

export default function Fields() {
  const { fields, farms, activeFieldId } = useApp();
  const [tab, setTab] = useState<"list" | "create">("list");

  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head">
        <div>
          <div className="page-title">Farms & fields</div>
          <div className="page-sub">
            The field is the spatial root of the system. Its polygon anchors every evidence layer, world-model snapshot
            and intelligence run — switching fields reloads everything and prevents cross-field leakage.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setTab(tab === "create" ? "list" : "create")} type="button">
          {tab === "create" ? "View fields" : "+ Add farm / field"}
        </button>
      </div>

      {tab === "list" ? (
        farms.length === 0 ? (
          <EmptyState
            emoji="🏡"
            title="No farm yet"
            body="Create a farm first, then add a field boundary."
            action={<button className="btn btn-primary" onClick={() => setTab("create")} type="button">Create farm</button>}
          />
        ) : (
          <div className="col" style={{ gap: 10 }}>
            {farms.map((farm) => (
              <FarmCard key={farm.id} farm={farm} fields={fields.filter((f) => f.farm_id === farm.id)} activeFieldId={activeFieldId} />
            ))}
          </div>
        )
      ) : (
        <CreateFlow />
      )}
    </div>
  );
}

function FarmCard({ farm, fields, activeFieldId }: { farm: FarmRecord; fields: FieldRecord[]; activeFieldId: string | null }) {
  return (
    <Card title={farm.name} right={farm.location_name ? <span className="faint" style={{ fontSize: 12 }}>{farm.location_name}</span> : undefined}>
      {fields.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>No fields on this farm yet.</div>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {fields.map((f) => (
            <div key={f.id} className="row" style={{ gap: 10, padding: "8px 10px", border: "1px solid var(--border)", borderRadius: 9, background: "rgba(141,199,161,0.03)" }}>
              <span style={{ fontSize: 15 }}>🗺️</span>
              <div className="grow">
                <strong style={{ fontSize: 13.5 }}>{f.name}</strong>
                <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>{f.crop_name ?? "no crop declared"}</span>
              </div>
              <span className="faint mono" style={{ fontSize: 12 }}>{fmtArea(f.area_m2)}</span>
              {activeFieldId === f.id && <Badge className="ps-AVAILABLE">active</Badge>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CreateFlow() {
  const { farms, refresh, setActiveField } = useApp();
  const [farmId, setFarmId] = useState<string>(farms[0]?.id ?? "");
  const [farmName, setFarmName] = useState("");
  const [farmLoc, setFarmLoc] = useState("");
  const [showFarm, setShowFarm] = useState(farms.length === 0);
  const [fieldName, setFieldName] = useState("");
  const [cropName, setCropName] = useState("");
  const [geomSource, setGeomSource] = useState<"draw" | "point" | "seed" | "geojson">("draw");
  const [ring, setRing] = useState<number[][]>([]);
  const [geoJsonText, setGeoJsonText] = useState("");
  const [busy, setBusy] = useState(false);
  // point + radius / current-location mode
  const [loc, setLoc] = useState<{ lat: number; lon: number } | null>(null);
  const [locState, setLocState] = useState<"idle" | "locating" | "ok" | "denied" | "unsupported">("idle");
  const [radiusM, setRadiusM] = useState(500);
  const [manualRefine, setManualRefine] = useState(false);
  const [latDraft, setLatDraft] = useState("");
  const [lonDraft, setLonDraft] = useState("");
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  const makeFarm = async () => {
    if (farmName.trim().length < 1) return;
    const res = await farmApi.createFarm(farmName.trim(), farmLoc.trim() || undefined);
    refresh();
    setFarmId(res.farm.id);
    setShowFarm(false);
    toast(`Farm “${res.farm.name}” created`);
  };

  // map init for drawing
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: DEFAULT_CENTER,
      zoom: 14,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({}), "top-left");
    m.on("load", () => {
      m.addSource("sketch-pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("sketch-line", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "sketch-line", type: "line", source: "sketch-line", paint: { "line-color": "#f5b942", "line-width": 2.5, "line-dasharray": [2, 1.5] } });
      m.addLayer({ id: "sketch-fill", type: "fill", source: "sketch-line", paint: { "fill-color": "#f5b942", "fill-opacity": 0.15 } });
      m.addLayer({ id: "sketch-pts", type: "circle", source: "sketch-pts", paint: { "circle-radius": 5, "circle-color": "#f5b942", "circle-stroke-color": "#0a120d", "circle-stroke-width": 1.5 } });
      m.on("click", (e) => {
        if (geomSourceRef.current === "point") setManualRefine(true);
        setRing((prev) => [...prev, [Number(e.lngLat.lng.toFixed(6)), Number(e.lngLat.lat.toFixed(6))]]);
      });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  // keep the current geometry source readable inside the map click handler
  const geomSourceRef = useRef(geomSource);
  geomSourceRef.current = geomSource;

  // reflect ring into the map
  useEffect(() => {
    const m = map.current;
    if (!m || !m.getSource("sketch-pts")) return;
    const closed = ring.length >= 3 ? [...ring, ring[0]] : ring;
    const pts = { type: "FeatureCollection" as const, features: ring.map((c) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Point" as const, coordinates: c } })) };
    const line = {
      type: "FeatureCollection" as const,
      features:
        ring.length >= 2
          ? [{ type: "Feature" as const, properties: {}, geometry: { type: "LineString" as const, coordinates: closed } }]
          : [],
    };
    (m.getSource("sketch-pts") as maplibregl.GeoJSONSource).setData(pts);
    (m.getSource("sketch-line") as maplibregl.GeoJSONSource).setData(line);
  }, [ring]);

  useEffect(() => {
    if (geomSource === "seed") {
      setRing(DEV_SEED_RING);
    } else if (geomSource === "point") {
      setManualRefine(false);
      if (loc) setRing(circleRing(loc.lat, loc.lon, radiusM));
      else setRing([]);
    } else if (geomSource === "draw" && ring.length === 0) {
      setRing([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geomSource]);

  // regenerate the AOI circle when the point or radius changes (unless the
  // user has refined the boundary by clicking extra points)
  useEffect(() => {
    if (geomSource !== "point" || !loc || manualRefine) return;
    setRing(circleRing(loc.lat, loc.lon, radiusM));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, radiusM, geomSource, manualRefine]);

  // keep the map centred on the chosen location
  useEffect(() => {
    const m = map.current;
    if (!m || !loc || geomSource !== "point") return;
    m.flyTo({ center: [loc.lon, loc.lat], zoom: 15 });
  }, [loc, geomSource]);

  const useCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setLocState("unsupported");
      return;
    }
    setLocState("locating");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude.toFixed(6));
        const lon = Number(pos.coords.longitude.toFixed(6));
        setLoc({ lat, lon });
        setLatDraft(String(lat));
        setLonDraft(String(lon));
        setLocState("ok");
      },
      (err) => {
        // 1 = PERMISSION_DENIED — surface the exact state, never silently
        // fall back to an unrelated default location.
        setLocState(err.code === 1 ? "denied" : "unsupported");
      },
      { timeout: 12_000, maximumAge: 60_000 },
    );
  };

  const applyManualCoords = () => {
    const lat = Number(latDraft);
    const lon = Number(lonDraft);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      toast("Enter valid latitude (−90…90) and longitude (−180…180)", "error");
      return;
    }
    setLoc({ lat, lon });
    setLocState("ok");
  };

  const finalGeometry = (() => {
    if ((geomSource === "seed" || geomSource === "draw" || geomSource === "point") && ring.length >= 3) {
      return { type: "Polygon" as const, coordinates: [[...ring, ring[0]]] };
    }
    if (geomSource === "geojson" && geoJsonText.trim()) {
      try {
        return JSON.parse(geoJsonText) as { type: "Polygon" | "MultiPolygon"; coordinates: unknown };
      } catch {
        return null;
      }
    }
    return null;
  })();

  const createField = async () => {
    if (!fieldName.trim() || !finalGeometry) return;
    if (!farmId) return;
    setBusy(true);
    try {
      const res = await farmApi.createField({
        farm_id: farmId,
        name: geomSource === "seed" ? `${fieldName.trim()} (DEVELOPMENT_SEED)` : fieldName.trim(),
        crop_name: cropName.trim() || null,
        geometry: finalGeometry,
      });
      refresh();
      setActiveField(res.field.id);
      setFieldName("");
      setCropName("");
      setRing([]);
      setGeoJsonText("");
      // Kick the full evidence pipeline immediately (weather → satellite → soil →
      // terrain → water → world model → intelligence) — no manual refresh needed.
      void worldApi
        .refresh(res.field.id)
        .then(() => refresh())
        .catch(() => undefined);
      toast(
        geomSource === "seed"
          ? "Development-seed field created — evidence pipeline started automatically"
          : "Field created — evidence pipeline started automatically (weather → satellite → soil → terrain → water → analysis)",
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      {showFarm && (
        <Card title="Create a farm">
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Farm name</label>
              <input className="input" value={farmName} onChange={(e) => setFarmName(e.target.value)} placeholder="e.g. Patel Family Farm" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Location (optional)</label>
              <input className="input" value={farmLoc} onChange={(e) => setFarmLoc(e.target.value)} placeholder="e.g. Nashik district, Maharashtra" />
            </div>
          </div>
          <button className="btn btn-primary mt-16" onClick={makeFarm} disabled={!farmName.trim()}>Create farm</button>
        </Card>
      )}

      {!showFarm && (
        <Card title="Add a field">
          <div className="field">
            <label>Farm</label>
            <select className="select" value={farmId} onChange={(e) => setFarmId(e.target.value)}>
              {farms.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Field name</label>
              <input className="input" value={fieldName} onChange={(e) => setFieldName(e.target.value)} placeholder="e.g. North Plot" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Crop (optional — field metadata only, not independently verified)</label>
              <input className="input" value={cropName} onChange={(e) => setCropName(e.target.value)} placeholder="e.g. Soybean" />
            </div>
          </div>

          <div className="section-label mt-16">Geometry source</div>
          <div className="tabs" style={{ borderBottom: "none", marginBottom: 8 }}>
            {([
              ["draw", "Draw on map"],
              ["point", "Point + radius / my location"],
              ["geojson", "Paste GeoJSON"],
              ["seed", "Development seed"],
            ] as const).map(([id, label]) => (
              <button key={id} className={`tab ${geomSource === id ? "active" : ""}`} onClick={() => setGeomSource(id)} type="button">
                {label}
              </button>
            ))}
          </div>

          {geomSource === "point" && (
            <Card className="mb-12">
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
                <div className="field" style={{ margin: 0 }}>
                  <label>Latitude</label>
                  <input className="input" inputMode="decimal" value={latDraft} onChange={(e) => setLatDraft(e.target.value)} placeholder="e.g. 19.9993" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>Longitude</label>
                  <input className="input" inputMode="decimal" value={lonDraft} onChange={(e) => setLonDraft(e.target.value)} placeholder="e.g. 73.7903" />
                </div>
                <div className="field" style={{ margin: 0 }}>
                  <label>Radius (AOI)</label>
                  <select className="select" value={radiusM} onChange={(e) => setRadiusM(Number(e.target.value))}>
                    {RADIUS_OPTIONS.map((r) => (
                      <option key={r} value={r}>{r >= 1000 ? `${r / 1000} km` : `${r} m`}</option>
                    ))}
                  </select>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-primary" onClick={applyManualCoords} type="button">Set coords</button>
                  <button className="btn" onClick={useCurrentLocation} disabled={locState === "locating"} type="button">
                    {locState === "locating" ? "Locating…" : "📍 Use my current location"}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12.5, marginTop: 8 }}>
                {locState === "ok" && loc && (
                  <span className="ok-text">
                    Location set: {loc.lat.toFixed(5)}, {loc.lon.toFixed(5)} — circular AOI of {radiusM >= 1000 ? `${radiusM / 1000} km` : `${radiusM} m`} generated (~
                    {(Math.PI * (radiusM / 1000) ** 2).toFixed(2)} km²). Click the map afterwards to add refinement points.
                  </span>
                )}
                {locState === "denied" && <span className="err-text">LOCATION_PERMISSION_DENIED — allow location access, or enter coordinates manually above.</span>}
                {locState === "unsupported" && <span className="err-text">Location unavailable in this browser — enter coordinates manually above.</span>}
                {locState === "idle" && <span className="faint">Use your current location or type coordinates. The AOI circle is an approximate discovery boundary — switch to “Draw on map” to refine it into a parcel boundary.</span>}
                {manualRefine && (
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <span className="faint">Boundary refined with added points.</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => { setManualRefine(false); if (loc) setRing(circleRing(loc.lat, loc.lon, radiusM)); }} type="button">Regenerate AOI circle</button>
                  </div>
                )}
              </div>
            </Card>
          )}

          {(geomSource === "draw" || geomSource === "point") && (
            <>
              <div className="map-wrap" style={{ height: geomSource === "draw" ? 380 : 320 }}>
                <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
                <div className="map-tools">
                  {geomSource === "draw" && (
                    <button className="btn btn-sm" onClick={() => setRing([])} type="button">Clear vertices ({ring.length})</button>
                  )}
                  {geomSource === "point" &&
                    (loc ? (
                      <button className="btn btn-sm" onClick={() => setRing([])} type="button">Clear boundary ({ring.length} pts)</button>
                    ) : (
                      <span className="badge ts-UNKNOWN">no point set yet</span>
                    ))}
                </div>
                <div className="map-legend">
                  {geomSource === "draw" ? (
                    <>Click the map to place vertices. A polygon needs at least 3. Use <em>Development seed</em> to load a labelled example boundary first.</>
                  ) : (
                    <>Map shows your AOI. {locState === "ok" && loc ? "Click to add refinement points." : "Set a point first (current location or coordinates)."}</>
                  )}
                </div>
              </div>
              {geomSource === "draw" && ring.length >= 3 && <Hint className="mt-8">Polygon ready — {ring.length} vertices. Click “Create field”.</Hint>}
              {geomSource === "point" && ring.length >= 3 && <Hint className="mt-8">AOI ready — {ring.length} boundary points around your location. Click “Create field”.</Hint>}
            </>
          )}

          {geomSource === "geojson" && (
            <>
              <textarea
                className="textarea"
                style={{ minHeight: 160, fontFamily: "var(--mono)", fontSize: 12 }}
                value={geoJsonText}
                onChange={(e) => setGeoJsonText(e.target.value)}
                placeholder='{"type":"Polygon","coordinates":[[[lon,lat],…]]}'
              />
              <div className="faint" style={{ fontSize: 12 }}>WGS84 lon/lat, closed ring. Polygon or MultiPolygon accepted.</div>
            </>
          )}

          {geomSource === "seed" && (
            <Hint warn>
              Loads an <strong>approximate boundary</strong> near Nashik, Maharashtra (India) — real coordinates, but a
              drawn approximation, not a surveyed field. The field will be named with a <Badge>DEVELOPMENT_SEED</Badge>{" "}
              label so it can never be mistaken for real farm geometry.
            </Hint>
          )}

          <div className="row mt-16">
            <button className="btn btn-primary" onClick={createField} disabled={busy || !fieldName.trim() || !finalGeometry || !farmId}>
              {busy ? "Creating…" : "Create field"}
            </button>
            {!finalGeometry && fieldName.trim() && <span className="faint" style={{ fontSize: 12.5 }}>finish a polygon (≥3 vertices) or paste valid GeoJSON</span>}
          </div>
        </Card>
      )}

      {farms.length > 0 && (
        <div>
          <Link to="/app" className="btn">← Back to the world model</Link>
        </div>
      )}
    </div>
  );
}