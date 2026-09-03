import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

const REMOTE_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// Minimal local style — the field polygon must render even when no external
// basemap provider is reachable (the UI then truthfully says BASEMAP UNAVAILABLE).
const MINIMAL_STYLE: any = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef3ef' } }],
};

const STATE_COLORS: Record<string, string> = {
  OBSERVED: 'bg-emerald-500/20 text-emerald-700', MODEL_DERIVED: 'bg-blue-500/20 text-blue-700', DERIVED: 'bg-sky-500/20 text-sky-700',
  ESTIMATED: 'bg-purple-500/20 text-purple-700', NO_DATA: 'bg-amber-500/20 text-amber-700', REANALYSIS: 'bg-teal-500/20 text-teal-700',
  UNKNOWN: 'bg-slate-9000/20 text-slate-300', MISSING: 'bg-rose-500/20 text-rose-700',
  AVAILABLE: 'bg-emerald-500/20 text-emerald-700', PREDICTED: 'bg-cyan-500/20 text-cyan-700',
};

type Ev = Record<string, any>;

export default function WorldPage() {
  const navigate = useNavigate();
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const { currentField } = useFieldStore();
  const [worldModel, setWorldModel] = useState<any>(null);
  const [evidence, setEvidence] = useState<Ev[]>([]);
  const [devices, setDevices] = useState<Ev[]>([]);
  const [risks, setRisks] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [basemap, setBasemap] = useState<'LOADING' | 'AVAILABLE' | 'UNAVAILABLE'>('LOADING');
  const [activeTab, setActiveTab] = useState<'state' | 'risks' | 'uncertainty' | 'evidence'>('state');
  const [mapError, setMapError] = useState<string | null>(null);

  // ── Map bootstrap with polygon-first fallback ──────────────────────────
  useEffect(() => {
    if (!mapContainer.current) return;
    let cancelled = false;
    const init = async () => {
      // Probe the basemap style first so a failed provider never blanks the map.
      let style: any = MINIMAL_STYLE;
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 7000);
        const r = await fetch(REMOTE_STYLE, { signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) { style = REMOTE_STYLE; }
        else throw new Error('basemap style unavailable');
      } catch { style = MINIMAL_STYLE; }
      if (cancelled) return;
      try {
        map.current = new maplibregl.Map({
          container: mapContainer.current!,
          style,
          center: [77.5946, 12.9716],
          zoom: 12,
          attributionControl: true,
        });
        setBasemap(style === REMOTE_STYLE ? 'AVAILABLE' : 'UNAVAILABLE');
        if (style === MINIMAL_STYLE) setMapError('BASEMAP UNAVAILABLE — external tile provider unreachable. Field geometry and stored evidence still render below.');
        map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
        map.current.on('error', (e: any) => {
          const msg = String(e?.error?.message || '');
          if (/tile|style|network|fetch/i.test(msg) && style === REMOTE_STYLE) {
            setBasemap('UNAVAILABLE');
            setMapError('BASEMAP UNAVAILABLE — external tile provider error. Field geometry and stored evidence still render.');
          }
        });
      } catch (e: any) {
        setMapError('Map could not start: ' + (e?.message || 'WebGL unavailable'));
      }
    };
    init();
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, []);

  const areaLabel = typeof currentField?.area_hectares === 'number' && isFinite(currentField.area_hectares)
    ? currentField!.area_hectares.toFixed(2) + ' hectares' : 'AREA UNKNOWN';

  const clearOverlays = useCallback(() => {
    const m = map.current;
    if (!m) return;
    ['field', 'footprints', 'devices', 'risk-marks'].forEach((id) => {
      if (m.getLayer(id)) m.removeLayer(id);
      if (m.getSource(id)) m.removeSource(id);
    });
  }, []);

  // ── Load every field-scoped view: world model, evidence, hardware ──────
  const loadField = useCallback(async () => {
    if (!currentField) return;
    // FIELD ISOLATION: clear stale panels before the new field arrives.
    setWorldModel(null);
    setEvidence([]);
    setRisks([]);
    setDevices([]);
    setActiveTab('state');
    clearOverlays();

    const m = map.current;
    if (m) {
      const bounds = new maplibregl.LngLatBounds();
      currentField.geometry.coordinates[0].forEach((c: number[]) => bounds.extend(c as [number, number]));
      m.fitBounds(bounds, { padding: 60 });
      const add = () => {
        if (!map.current) return;
        if (map.current.getSource('field')) {
          (map.current.getSource('field') as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: currentField.geometry });
        } else {
          map.current.addSource('field', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: currentField.geometry } });
          map.current.addLayer({ id: 'field-fill', type: 'fill', source: 'field', paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.18 } });
          map.current.addLayer({ id: 'field-border', type: 'line', source: 'field', paint: { 'line-color': '#16a34a', 'line-width': 3 } });
        }
      };
      if (m.loaded()) add(); else m.once('load', add);
    }

    try {
      const [wm, ev, dev] = await Promise.all([
        api.get<any>('/fields/' + currentField.id + '/world-model'),
        api.get<{ success: boolean; data: Ev[] }>('/fields/' + currentField.id + '/evidence'),
        api.get<any>('/fields/' + currentField.id + '/devices'),
      ]);
      if (wm.success) {
        setWorldModel(wm.data);
        setRisks((wm.data.risks || []).filter((r: Ev) => r.severity));
      }
      if (ev.success && ev.data) setEvidence(ev.data || []);
      if (dev.success) setDevices((dev.data?.devices || []).filter((d: Ev) => d.location?.coordinates));
    } catch (e) { console.error(e); }
  }, [currentField, clearOverlays]);

  useEffect(() => { loadField(); }, [loadField]);

  // Real spatial overlays once map + data are ready
  useEffect(() => {
    const m = map.current;
    if (!m || !m.loaded() || !evidence.length) return;
    const footprints = evidence.filter((e) => e.source === 'EARTH_OBSERVATION' && e.geometry?.type === 'Polygon');
    const geoDevices = devices.map((d) => ({
      type: 'Feature' as const,
      properties: { id: d.id, name: d.name || d.id, type: d.type, state: d.derived_state || 'UNKNOWN' },
      geometry: d.location,
    }));
    const geoRisks = risks.map((r) => ({
      type: 'Feature' as const,
      properties: { id: r.id, type: r.type, severity: r.severity },
      geometry: { type: 'Point', coordinates: [currentField!.centroid.coordinates[0], currentField!.centroid.coordinates[1]] },
    }));
    const addLayers = () => {
      if (!map.current) return;
      // Satellite footprints (real acquisitions) — outlined, never imagery
      if (footprints.length && !map.current.getSource('footprints')) {
        map.current.addSource('footprints', { type: 'geojson', data: { type: 'FeatureCollection', features: footprints.map((f) => ({ type: 'Feature', properties: { id: f.id, provider: f.provider }, geometry: f.geometry })) } });
        map.current.addLayer({ id: 'footprints', type: 'line', source: 'footprints', paint: { 'line-color': '#7c3aed', 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [2, 1.5] } });
      }
      if (geoDevices.length && !map.current.getSource('devices')) {
        map.current.addSource('devices', { type: 'geojson', data: { type: 'FeatureCollection', features: geoDevices } });
        map.current.addLayer({ id: 'devices', type: 'circle', source: 'devices', paint: { 'circle-radius': 6, 'circle-color': '#06b6d4', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
      }
      if (geoRisks.length && !map.current.getSource('risk-marks')) {
        map.current.addSource('risk-marks', { type: 'geojson', data: { type: 'FeatureCollection', features: geoRisks } });
        map.current.addLayer({ id: 'risk-marks', type: 'circle', source: 'risk-marks', paint: { 'circle-radius': 7, 'circle-color': '#ef4444', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } });
      }
    };
    if (m.loaded()) addLayers(); else m.once('load', addLayers);
  }, [evidence, devices, risks, currentField]);

  const runAnalysis = async () => {
    if (!currentField) return;
    setAnalyzing(true);
    try {
      const r = await api.post<any>('/fields/' + currentField.id + '/analyze', {});
      if (r.success) {
        const wm = r.data.world_model || {};
        setWorldModel({ coverage: wm.coverage, state: { weather: { state: wm.weather_state }, satellite: { state: wm.satellite_state }, sensors: { state: wm.sensor_state }, soil: { state: wm.soil_state }, water: { state: wm.water_state } }, risks: r.data.risks, anomalies: r.data.anomalies, contradictions: r.data.contradictions, uncertainty: r.data.uncertainty, evidence_gaps: wm.evidence_gaps });
        setRisks((r.data.risks || []).filter((x: Ev) => x.severity));
      }
      loadField();
    } catch (e) { console.error(e); }
    finally { setAnalyzing(false); }
  };

  // Real-time SSE refresh for the selected field
  useEffect(() => {
    if (!currentField) return;
    const es = new EventSource('/api/system/events/stream');
    const onEvent = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data);
        if (!ev || ev.field_id !== currentField.id) return;
        if (['OBSERVATION_RECEIVED', 'WORLD_MODEL_UPDATED', 'ANALYSIS_COMPLETED', 'SENSOR_CONNECTED'].includes(ev.type)) loadField();
      } catch { /* ignore */ }
    };
    es.addEventListener('message', onEvent);
    return () => es.close();
  }, [currentField?.id, loadField]);

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">🌍</div>
      <h2 className="text-xl font-semibold text-slate-200 mb-2">World</h2>
      <p className="text-slate-500">Select a field from the top bar</p>
    </div>
  );

  // Timeline strip from real evidence
  const timeline = [...evidence]
    .filter((e) => e.observation_time)
    .sort((a, b) => String(b.observation_time).localeCompare(String(a.observation_time)))
    .slice(0, 12);
  const footprints = evidence.filter((e) => e.source === 'EARTH_OBSERVATION' && e.geometry?.type === 'Polygon');

  const zoomToEvidence = (e: Ev) => {
    const m = map.current;
    if (!m || !e.geometry) return;
    if (e.geometry.type === 'Polygon') {
      const b = new maplibregl.LngLatBounds();
      e.geometry.coordinates[0].forEach((c: number[]) => b.extend(c as [number, number]));
      m.fitBounds(b, { padding: 100 });
    } else if (e.geometry.type === 'Point') {
      m.flyTo({ center: [e.geometry.coordinates[0], e.geometry.coordinates[1]], zoom: 15 });
    }
  };

  const summary = (e: Ev) => (typeof e.measurement === 'object' && e.measurement ? JSON.stringify(e.measurement).slice(0, 110) : String(e.measurement ?? ''));

  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* MAP — full viewport */}
      <div ref={mapContainer} className="absolute inset-0" />
      {mapError && (
        <div className="absolute top-16 left-4 z-10 bg-amber-50 border border-amber-300 text-amber-800 text-xs px-3 py-1.5 rounded-lg shadow">
          {mapError}
        </div>
      )}

      {/* Top-left: field identity over the map */}
      <div className="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur-sm rounded-xl p-3.5 shadow-lg border border-slate-600 min-w-[190px]">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-bold text-slate-200 truncate">{currentField.name}</h3>
          <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${basemap === 'AVAILABLE' ? 'bg-emerald-500/15 text-emerald-700' : basemap === 'UNAVAILABLE' ? 'bg-amber-500/15 text-amber-700' : 'bg-slate-9000/15 text-slate-300'}`}>
            {basemap === 'UNAVAILABLE' ? 'BASEMAP UNAVAILABLE' : basemap === 'LOADING' ? 'basemap…' : 'map online'}
          </span>
        </div>
        <p className="text-xs text-slate-500 mt-0.5">{areaLabel}</p>
        <p className="text-[10px] text-slate-400 mt-1">
          {footprints.length} satellite footprint{footprints.length === 1 ? '' : 's'} · {devices.length} device{devices.length === 1 ? '' : 's'} positioned · {risks.length} risk{risks.length === 1 ? '' : 's'} (field-scope)
        </p>
      </div>

      {/* Top-right: actions */}
      <div className="absolute top-4 right-4 z-10 flex gap-2">
        <button onClick={() => navigate('/satellite')} className="bg-white/90 hover:bg-white border border-slate-600 text-slate-300 text-xs font-medium px-3 py-2 rounded-lg shadow backdrop-blur-sm">🛰️ Open Satellite</button>
        <button onClick={runAnalysis} disabled={analyzing} className="bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium px-3 py-2 rounded-lg shadow flex items-center gap-1.5">
          {analyzing ? (<><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>) : ('⚡ Analyze Field')}
        </button>
      </div>

      {/* Right: contextual intelligence — floating translucent panel */}
      <div className="absolute top-4 bottom-24 right-4 z-10 w-[340px] bg-white/90 backdrop-blur-md rounded-xl border border-slate-600 shadow-xl flex flex-col overflow-hidden">
        <div className="px-4 pt-3 pb-2 border-b border-slate-600">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-200">Intelligence</h3>
            <span className="text-[10px] text-slate-400">{worldModel?.last_updated ? new Date(worldModel.last_updated).toLocaleTimeString() : ''}</span>
          </div>
        </div>
        <div className="px-3 py-2">
          <div className="bg-slate-900 border border-slate-600 rounded-lg p-2.5">
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] font-medium text-slate-300">Evidence Coverage</span>
              <span className="text-[9px] text-slate-400">{worldModel?.coverage?.label || 'NOT_COMPUTED'}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold text-slate-200">{worldModel?.coverage ? worldModel.coverage.total_evidence : '—'}</span>
              <span className="text-[10px] text-slate-500">evidence items — a coverage count, never confidence</span>
            </div>
            {worldModel?.coverage?.domains && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {Object.entries(worldModel.coverage.domains).map(([d, st]: [string, unknown]) => (
                  <span key={d} className={`text-[9px] px-1.5 py-0.5 rounded-full ${st === 'AVAILABLE' ? 'bg-emerald-500/15 text-emerald-700' : 'bg-amber-500/15 text-amber-700'}`}>{d}: {String(st)}</span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex gap-1 px-3 pb-2">
          {(['state', 'risks', 'uncertainty', 'evidence'] as const).map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className={`flex-1 text-[11px] py-1.5 rounded-md transition-colors capitalize ${activeTab === tab ? 'bg-blue-600 text-white' : 'text-slate-500 hover:bg-slate-800'}`}>
              {tab === 'uncertainty' ? 'gaps' : tab}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2 text-xs">
          {activeTab === 'state' && worldModel && (
            <div className="space-y-1.5">
              {Object.entries(worldModel.state || {}).map(([key, value]: [string, any]) => {
                const s = value?.state || 'UNKNOWN';
                return (
                  <div key={key} className="flex items-center justify-between bg-slate-900 border border-slate-600 rounded-lg px-2.5 py-2">
                    <span className="text-slate-300 capitalize">{key}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${STATE_COLORS[s] || STATE_COLORS.UNKNOWN}`}>{s}</span>
                  </div>
                );
              })}
              {(worldModel.evidence_gaps || []).length > 0 && (
                <div className="pt-1">
                  <p className="text-[10px] font-semibold text-slate-500 mb-1">WHY UNKNOWN / GAPS</p>
                  {worldModel.evidence_gaps.slice(0, 4).map((g: string, i: number) => (
                    <p key={i} className="text-[10px] text-amber-700 leading-relaxed">{g}</p>
                  ))}
                </div>
              )}
            </div>
          )}
          {activeTab === 'risks' && (
            <div className="space-y-1.5">
              {(risks || []).length ? risks.map((r) => (
                <div key={r.id} className="bg-slate-900 border border-slate-600 rounded-lg p-2.5 border-l-2 border-l-rose-400">
                  <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-300">{r.type}</span><span className="text-[10px] text-slate-400">{r.severity}</span></div>
                  <p className="text-[10px] text-slate-500 mt-0.5">{r.description || r.trigger_reason || ''}</p>
                  <p className="text-[9px] text-slate-400 mt-1">uncertainty: <span className="text-amber-700">{r.uncertainty || 'NOT_ASSESSED'}</span></p>
                </div>
              )) : <p className="text-slate-400 text-center py-6">No risks computed — run Analyze Field or wait for evidence-driven analysis.</p>}
            </div>
          )}
          {activeTab === 'uncertainty' && (
            <div className="space-y-1.5">
              {worldModel?.coverage?.domains && (
                <div className="bg-slate-900 border border-slate-600 rounded-lg p-2.5">
                  {Object.entries(worldModel.coverage.domains).map(([d, st]: [string, unknown]) => (
                    <div key={d} className="flex justify-between py-0.5"><span className="text-slate-300 capitalize">{d}</span><span className="text-[10px] text-slate-500">{String(st)}</span></div>
                  ))}
                </div>
              )}
              {(worldModel?.uncertainty?.explanation || []).length > 0 && worldModel.uncertainty.explanation.slice(0, 8).map((e: string, i: number) => (
                <p key={i} className="text-[10px] text-amber-700 leading-relaxed">{e}</p>
              ))}
              {(worldModel?.uncertainty?.data_quality && worldModel.uncertainty.data_quality !== 'NOT_ASSESSED') ? (
                <p className="text-[10px] text-slate-500">Data quality: {worldModel.uncertainty.data_quality}</p>
              ) : <p className="text-[10px] text-slate-400 italic">Aggregate quality scoring: NOT_ASSESSED (no calibrated quality model).</p>}
            </div>
          )}
          {activeTab === 'evidence' && (
            <div className="space-y-1.5">
              {evidence.length ? evidence.slice(0, 30).map((e) => (
                <div key={e.id} className="bg-slate-900 border border-slate-600 rounded-lg px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-medium text-slate-300 truncate">{e.provider || e.source}</span>
                    <span className={`text-[9px] px-1.5 rounded-full ${STATE_COLORS[e.state] || STATE_COLORS.UNKNOWN}`}>{e.state}</span>
                  </div>
                  <p className="text-[10px] text-slate-400 truncate">{summary(e)}</p>
                  <p className="text-[9px] text-slate-400">{e.observation_time ? new Date(e.observation_time).toLocaleString() : ''}</p>
                </div>
              )) : <p className="text-slate-400 text-center py-6">No evidence stored — run provider fetches or Analyze Field.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Bottom: acquisition / evidence timeline */}
      <div className="absolute bottom-3 left-3 right-3 z-10">
        <div className="bg-white/85 backdrop-blur-md rounded-xl border border-slate-600 shadow-lg px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-slate-300">EVIDENCE TIMELINE — real acquisitions & observations (click to zoom)</span>
            {footprints.length > 0 && <span className="text-[9px] text-purple-700 bg-purple-500/10 px-1.5 py-0.5 rounded-full">footprints shown on map</span>}
          </div>
          {timeline.length ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {timeline.map((e) => (
                <button key={e.id} onClick={() => zoomToEvidence(e)}
                  className="shrink-0 text-left bg-slate-900 hover:bg-slate-800 border border-slate-600 rounded-lg px-2.5 py-1.5 min-w-[150px]">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[9px] font-semibold text-slate-300">{e.source.replace(/_/g, ' ')}</span>
                    <span className={`text-[8px] px-1 rounded-full ${STATE_COLORS[e.state] || ''}`}>{e.state}</span>
                  </div>
                  <p className="text-[10px] text-slate-500 truncate mt-0.5">{e.observation_time ? new Date(e.observation_time).toLocaleString() : '—'}</p>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400 py-1">No real evidence yet — run Analyze Field or fetch providers from the workspaces.</p>
          )}
        </div>
      </div>
    </div>
  );
}
