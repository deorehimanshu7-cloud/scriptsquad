import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useApp } from "../../lib/state";
import { spaceApi, toast, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, Spinner, Stat, TruthBadge, ProviderBadge } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { useI18n } from "../../lib/i18n";
import { fmtArea, fmtDate, fmtNum, timeAgo } from "../../lib/format";
import type { Domain, ProviderState, SatelliteProduct, TruthState } from "../../lib/types";
import { DOMAIN_LABELS } from "../../lib/types";

type Basemap = "dark" | "light" | "sat";

const BASEMAPS: Record<Basemap, maplibregl.StyleSpecification | string> = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  sat: {
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
  },
};

interface WmEnvelope {
  id: string;
  trigger: string;
  created_at: string;
  domains: { domain: Domain; state: string; latest_evidence_id: string | null; latest_at: string | null; count: number; summary: string; entries: unknown[] }[];
  field: { name: string; farm: string | null; area_m2: number | null; centroid: { lat: number; lon: number } } | null;
  devices: { id: string; name: string; kind: string; status: string; last_seen_at: string | null }[];
  satellite: { count: number; last_acquisition: string | null };
  freshness: Record<string, { level: string; reason: string }>;
  composed_at: string;
}

function geoJsonOf(field: { geometry: unknown }): Record<string, unknown> {
  return { type: "Feature", properties: {}, geometry: field.geometry };
}

export default function World() {
  return (
    <RequireField>
      <WorldInner />
    </RequireField>
  );
}

function WorldInner() {
  const { activeField, refreshToken, refresh } = useApp();
  const { t } = useI18n();
  const field = activeField!;
  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const [wm, setWm] = useState<WmEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("dark");
  const [products, setProducts] = useState<SatelliteProduct[]>([]);
  const [prodLoading, setProdLoading] = useState(false);
  const bootstrappedFor = useRef<Set<string>>(new Set());

  // load world model + products when the field changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setWm(null);
    setProducts([]);
    void worldApi.worldModel(field.id).then((res) => {
      if (cancelled) return;
      if (res.world_model) {
        const snap = res.world_model.snapshot as unknown as WmEnvelope;
        setWm(snap);
      }
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    setProdLoading(true);
    void spaceApi.products(field.id).then((res) => {
      if (!cancelled) setProducts(res.products);
      setProdLoading(false);
    }).catch(() => { if (!cancelled) setProdLoading(false); });
    return () => {
      cancelled = true;
    };
  }, [field.id, refreshToken]);

  // init map once
  useEffect(() => {
    if (!mapEl.current || map.current) return;
    const m = new maplibregl.Map({
      container: mapEl.current,
      style: BASEMAPS.dark as string,
      center: [field.centroid_lon, field.centroid_lat],
      zoom: 13,
      pitch: 45,
      attributionControl: { compact: true },
    });
    m.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    m.on("load", () => {
      m.addSource("field", { type: "geojson", data: geoJsonOf(field) as never });
      m.addLayer({ id: "field-fill", type: "fill", source: "field", paint: { "fill-color": "#3fd97c", "fill-opacity": 0.16 } });
      m.addLayer({ id: "field-line", type: "line", source: "field", paint: { "line-color": "#3fd97c", "line-width": 2.2 } });
      m.addLayer({
        id: "centroid",
        type: "circle",
        source: {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [field.centroid_lon, field.centroid_lat] } },
        },
        paint: { "circle-radius": 5, "circle-color": "#f5b942", "circle-stroke-color": "#0a120d", "circle-stroke-width": 2 },
      });
      m.addSource("sat-products", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "sat-footprints",
        type: "line",
        source: "sat-products",
        paint: { "line-color": "#5da9f6", "line-width": 1.2, "line-opacity": 0.65 },
      });
      const bbox = field.bbox;
      m.fitBounds([[bbox.min_lon, bbox.min_lat], [bbox.max_lon, bbox.max_lat]], { padding: 70, pitch: 45, maxZoom: 15 });
    });
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // basemap switch
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    void m.setStyle(BASEMAPS[basemap] as string);
  }, [basemap]);

  // keep field + satellite layers in sync, and refit the camera on field switch
  const lastFieldId = useRef<string>(field.id);
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const update = () => {
      const src = m.getSource("field");
      if (src && "setData" in src) (src as maplibregl.GeoJSONSource).setData(geoJsonOf(field) as never);
      const pSrc = m.getSource("sat-products");
      if (pSrc && "setData" in pSrc) {
        const features = products
          .filter((p) => p.geometry && typeof p.geometry === "object" && (p.geometry as { type?: string }).type === "Polygon")
          .map((p) => ({ type: "Feature" as const, properties: { id: p.id }, geometry: p.geometry }));
        (pSrc as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features });
      }
      if (lastFieldId.current !== field.id) {
        lastFieldId.current = field.id;
        const b = field.bbox;
        m.fitBounds([[b.min_lon, b.min_lat], [b.max_lon, b.max_lat]], { padding: 70, pitch: 45, maxZoom: 15 });
      }
    };
    if (m.loaded()) update();
    else m.once("load", update);
  }, [field, products]);

  // Continuous behaviour: a field with no world model yet (freshly created, or
  // never analysed) gets its full pipeline kicked automatically once per session
  // — the user never has to discover that “Run pipeline” exists.
  useEffect(() => {
    if (loading || wm || bootstrappedFor.current.has(field.id)) return;
    bootstrappedFor.current.add(field.id);
    void worldApi
      .refresh(field.id)
      .then(() => refresh())
      .catch(() => undefined);
  }, [loading, wm, field.id, refresh]);

  const analyze = useCallback(async () => {
    setRunning(true);
    try {
      const res = await worldApi.analyze(field.id);
      toast(`Analysis complete — ${res.report.anomalies} anomalies, ${res.report.risks} risks, ${res.report.uncertainties} uncertainties, ${res.report.contradictions} contradictions`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Analysis failed", "error");
    } finally {
      setRunning(false);
    }
  }, [field.id, refresh]);

  const refreshPipeline = useCallback(async () => {
    setRunning(true);
    try {
      const res = await worldApi.refresh(field.id);
      toast(res.note ?? "Scheduled pipeline ran — provider jobs executed with truthful states");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Refresh failed", "error");
    } finally {
      setRunning(false);
    }
  }, [field.id, refresh]);

  const discover = useCallback(async () => {
    setProdLoading(true);
    try {
      const res = await spaceApi.discover(field.id);
      toast(`Satellite discovery ran — ${res.total_products} product(s) recorded`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Discovery failed", "error");
    } finally {
      setProdLoading(false);
    }
  }, [field.id, refresh]);

  const domains = wm?.domains ?? [];

  return (
    <div className="page" style={{ maxWidth: 1600 }}>
      <div className="page-head">
        <div>
          <div className="page-title">{t("world.title", { field: field.name })}</div>
          <div className="page-sub">{t("world.sub")}</div>
        </div>
        <div className="row">
          <div className="row" style={{ gap: 4, border: "1px solid var(--border-strong)", borderRadius: 10, padding: 3 }}>
            <button className="btn btn-sm btn-primary" type="button">2D</button>
            <Link to="/app/twin" className="btn btn-sm btn-ghost">3D</Link>
            <Link to="/app/twin?split=1" className="btn btn-sm btn-ghost">Split</Link>
          </div>
          <button className="btn" onClick={discover} disabled={prodLoading}>
            {prodLoading ? "…" : "🛰️"} {t("world.checkAcq")}
          </button>
          <button className="btn" onClick={refreshPipeline} disabled={running} title={t("world.sub")}>
            {running ? <span className="spinner" /> : "🔄"} {t("world.refresh")}
          </button>
          <button className="btn btn-primary" onClick={analyze} disabled={running}>
            {running ? <span className="spinner" /> : "⚡"} {t("world.analyze")}
          </button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 340px", alignItems: "start" }}>
        <div>
          <div className="map-wrap" style={{ height: "calc(100vh - 190px)", minHeight: 480 }}>
            <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
            <div className="map-tools">
              <div className="row" style={{ gap: 4 }}>
                {(["dark", "light", "sat"] as Basemap[]).map((b) => (
                  <button key={b} className={`btn btn-sm ${basemap === b ? "btn-primary" : ""}`} onClick={() => setBasemap(b)} type="button">
                    {b === "dark" ? t("world.dark") : b === "light" ? t("world.light") : t("world.sat")}
                  </button>
                ))}
              </div>
            </div>
            <div className="map-legend">
              <div className="row" style={{ gap: 8 }}>
                <span className="row" style={{ gap: 4 }}><span style={{ width: 14, height: 3, background: "#3fd97c", display: "inline-block" }} /> {t("world.legendField")}</span>
                <span className="row" style={{ gap: 4 }}><span style={{ width: 8, height: 8, borderRadius: 50, background: "#f5b942", display: "inline-block" }} /> {t("world.legendCentroid")}</span>
                <span className="row" style={{ gap: 4 }}><span style={{ width: 14, height: 3, background: "#5da9f6", display: "inline-block" }} /> {t("world.legendAcq", { n: products.length })}</span>
              </div>
              {basemap === "sat" && <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>{t("world.satNote")}</div>}
            </div>
          </div>

          {products.length > 0 && (
            <Card title={t("world.acqTitle", { n: products.length })} className="mt-16">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t("sat.satellite")}</th><th>{t("world.acquired")}</th><th>{t("world.cloud")}</th><th>{t("world.res")}</th><th>{t("world.product")}</th><th>{t("c.status")}</th>
                  </tr>
                </thead>
                <tbody>
                  {products.slice(0, 8).map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.satellite}</td>
                      <td className="nowrap">{fmtDate(p.acquired_at)}</td>
                      <td>{p.cloud_cover !== null ? `${fmtNum(p.cloud_cover, 0)}%` : "—"}</td>
                      <td>{p.resolution_m ? `${fmtNum(p.resolution_m, 0)} m` : "—"}</td>
                      <td className="mono" style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.product_id}</td>
                      <td><Badge className={`ps-${p.status === "auth_required" ? "AUTH_REQUIRED" : "AVAILABLE"}`}>{p.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>

        <div className="col" style={{ gap: 16 }}>
          {loading ? (
            <Spinner label={t("world.composing")} />
          ) : !wm ? (
            <EmptyState
              emoji="🗺️"
              title={t("world.notComposedTitle")}
              body={t("world.notComposedBody")}
              action={<button className="btn btn-primary" onClick={analyze} disabled={running}>{t("world.composeNow")}</button>}
            />
          ) : (
            <>
              <Card title={t("world.fieldSnapshot")} right={<span className="faint mono">{timeAgo(wm.composed_at)}</span>}>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Stat label={t("world.area")} value={fmtArea(wm.field?.area_m2 ?? null)} />
                  <Stat label={t("world.evidenceRecords")} value={domains.reduce((a, d) => a + d.count, 0)} />
                  <Stat label={t("world.devices")} value={wm.devices?.length ?? 0} hint={wm.devices?.length ? t("world.registered") : t("world.noneReg")} />
                  <Stat label={t("nav.satellite")} value={wm.satellite?.count ?? 0} hint={wm.satellite?.last_acquisition ? t("world.latestAt", { t: fmtDate(wm.satellite.last_acquisition) }) : t("c.none")} />
                </div>
              </Card>

              {domains.map((d) => (
                <DomainCard key={d.domain} d={d} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DomainCard({ d }: { d: WmEnvelope["domains"][number] }) {
  const { t } = useI18n();
  const state = d.state as TruthState | "NO_DATA" | "AUTH_REQUIRED" | "NOT_CONFIGURED" | "PARTIAL";
  const isProviderish = ["NO_DATA", "AUTH_REQUIRED", "NOT_CONFIGURED"].includes(state);
  return (
    <Card title={`${DOMAIN_LABELS[d.domain] ?? d.domain}`} right={<Badge className="mono" style={{ fontSize: 10.5 }}>{t("world.records", { n: d.count })}</Badge>}>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        {isProviderish ? <ProviderBadge state={state as ProviderState} /> : <TruthBadge state={state as TruthState} />}
        {d.latest_at && <span className="faint" style={{ fontSize: 11.5 }}>{t("world.latestAt", { t: timeAgo(d.latest_at) })}</span>}
      </div>
      <div className="muted" style={{ fontSize: 12.5 }}>{d.summary}</div>
    </Card>
  );
}