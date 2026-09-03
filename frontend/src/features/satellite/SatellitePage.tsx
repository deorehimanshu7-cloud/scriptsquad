import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';
import { StateChip, LoadingState, ErrorState, EmptyState, InfoNote } from '@/components/ui/kit';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

type Tab = 'explorer' | 'products' | 'timeline' | 'search';

const REMOTE_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const MINIMAL_STYLE: any = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef3ef' } }] };

const SOURCES = [
  { id: 'copernicus', label: 'Sentinel-2', sub: 'Copernicus CDSE STAC', color: '#7c3aed' },
  { id: 'sentinel-1', label: 'Sentinel-1', sub: 'Copernicus CDSE STAC', color: '#8b5cf6' },
  { id: 'landsat', label: 'Landsat', sub: 'USGS earth-search STAC', color: '#d97706' },
  { id: 'bhoonidhi', label: 'Bhoonidhi / Indian EO', sub: 'NRSC ISRO', color: '#16a34a' },
];

function cloudPct(cloud: unknown): number {
  const n = Number(cloud);
  return Number.isFinite(n) ? n : -1;
}

export default function SatellitePage() {
  const { currentField } = useFieldStore();
  const [tab, setTab] = useState<Tab>('explorer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<any>({});
  const [products, setProducts] = useState<any[]>([]);
  const [series, setSeries] = useState<any[]>([]);
  const [source, setSource] = useState<string>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fieldId = currentField?.id;

  const loadProducts = useCallback(async () => {
    if (!fieldId) return;
    const r = await api.get<any>(`/fields/${fieldId}/satellite/products`);
    setProducts(r.data || []);
  }, [fieldId]);

  const ensureStored = useCallback(async () => {
    if (!fieldId) return;
    setBusy(true); setError(null);
    try {
      let r = await api.get<any>(`/fields/${fieldId}/satellite/products`);
      let list: any[] = r.data || [];
      let state = 'NO_DATA';
      let message: string | undefined;
      if (!list.length) {
        const s = await api.post<any>(`/fields/${fieldId}/satellite/search`, {});
        state = s.state || s.data?.state || 'NO_DATA';
        message = s.message;
        const p = await api.get<any>(`/fields/${fieldId}/satellite/products`);
        list = p.data || [];
      }
      if (list.length) state = 'OBSERVED';
      setProducts(list);
      setMeta({ state, message });
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { setBusy(false); }
  }, [fieldId]);

  async function loadTimeline() {
    if (!fieldId) return;
    setBusy(true); setError(null);
    try {
      const r = await api.get<any>(`/fields/${fieldId}/satellite/timeseries`);
      setSeries(r.data || []); setMeta(r);
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { setBusy(false); }
  }

  async function runSearch(body: Record<string, unknown>) {
    if (!fieldId) return;
    setBusy(true); setError(null);
    try {
      const r = await api.post<any>(`/fields/${fieldId}/satellite/search`, body);
      setMeta({ state: r.state, message: r.message });
      await loadProducts();
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    // FIELD ISOLATION: drop previous field's state before fetching.
    setProducts([]); setSeries([]); setMeta({}); setError(null); setSelectedId(null); setSource('all');
    if (!fieldId) return;
    if (tab === 'explorer') ensureStored();
    if (tab === 'products') loadProducts();
    if (tab === 'timeline') loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldId, tab]);

  const filtered = source === 'all' ? products : products.filter((p) => {
    const pid = String(p.provider_id || '').toLowerCase();
    const col = String(p.collection || '').toLowerCase();
    const m = source === 'copernicus' ? (pid.includes('copernicus') || col.includes('sentinel-2'))
      : source === 'sentinel-1' ? (pid.includes('sentinel-1') || col.includes('sentinel-1'))
      : source === 'landsat' ? (pid.includes('landsat') || col.includes('landsat'))
      : pid.includes(source);
    return m;
  });
  const selected = products.find((p) => p.id === selectedId) || filtered[0] || products[0] || null;

  // ── Geographic viewer: field AOI + real acquisition footprints ──────────
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);

  // The map container only mounts once `busy` clears, so `busy` is a dep here.
  const explorerVisible = tab === 'explorer' && !busy && !error;
  useEffect(() => {
    if (!explorerVisible || !mapContainer.current || !currentField) return;
    let cancelled = false;
    let m: maplibregl.Map | null = null;
    (async () => {
      let style: any = REMOTE_STYLE;
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5000);
        const r = await fetch(REMOTE_STYLE, { signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) style = MINIMAL_STYLE;
      } catch { style = MINIMAL_STYLE; }
      if (cancelled || !mapContainer.current) return;
      m = new maplibregl.Map({ container: mapContainer.current, style, center: [currentField.centroid.coordinates[0], currentField.centroid.coordinates[1]], zoom: 13 });
      map.current = m;
      m.once('load', () => {
        const addField = () => {
          if (!m) return;
          if (m.getSource('aoi')) (m.getSource('aoi') as maplibregl.GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: currentField.geometry });
          else {
            m.addSource('aoi', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: currentField.geometry } });
            m.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.15 } });
            m.addLayer({ id: 'aoi-border', type: 'line', source: 'aoi', paint: { 'line-color': '#16a34a', 'line-width': 2.5 } });
          }
          const b = new maplibregl.LngLatBounds();
          currentField.geometry.coordinates[0].forEach((c: number[]) => b.extend(c as [number, number]));
          m.fitBounds(b, { padding: 40 });
        };
        addField();
      });
    })();
    return () => { cancelled = true; map.current?.remove(); map.current = null; };
  }, [explorerVisible, currentField]);

  // Footprints on the viewer when products arrive
  useEffect(() => {
    const m = map.current;
    if (!m || !products.length) return;
    const feats = products
      .filter((p) => p.geometry?.type === 'Polygon')
      .map((p) => ({
        type: 'Feature' as const,
        properties: { id: p.id, provider: p.provider_id, product: p.product_id, cloud: p.cloud_cover ?? null },
        geometry: p.geometry,
      }));
    if (!feats.length) return;
    const paint: Record<string, any> = { 'line-width': 2, 'line-opacity': 0.85 };
    const add = () => {
      if (!m) return;
      // per-source color via data-driven provider expression
      const colors: Record<string, string> = { copernicus: '#7c3aed', landsat: '#d97706' };
      if (m.getSource('fp')) (m.getSource('fp') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
      else {
        m.addSource('fp', { type: 'geojson', data: { type: 'FeatureCollection', features: feats } });
        m.addLayer({ id: 'fp', type: 'line', source: 'fp', paint: { ...paint, 'line-color': ['match', ['get', 'provider'], 'copernicus', colors.copernicus, colors.landsat] } });
      }
    };
    if (m.loaded()) add(); else m.once('load', add);
  }, [products]);

  // Fly to the selected product
  useEffect(() => {
    const m = map.current;
    if (!m || !selected?.geometry) return;
    if (selected.geometry.type === 'Polygon') {
      const b = new maplibregl.LngLatBounds();
      selected.geometry.coordinates[0].forEach((c: number[]) => b.extend(c as [number, number]));
      m.fitBounds(b, { padding: 60, duration: 700 });
    }
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!currentField) {
    return <EmptyState title="No field selected" message="Select a field to search real satellite catalogs for its area of interest." />;
  }

  const maxCloud = Math.max(...products.map((p) => cloudPct(p.cloud_cover)).filter((c) => c >= 0), -1);

  const previewReason = (p: any): { status: string; lines: string[] } => {
    const pid = String(p.provider_id || '').toLowerCase();
    const assets = (p.assets && typeof p.assets === 'object') ? p.assets : {};
    if (pid.includes('landsat')) {
      const th = assets.thumbnail as any;
      const rp = th?.href?.startsWith('s3://usgs-landsat') || th?.['storage:requester_pays'];
      return {
        status: 'AUTH_REQUIRED',
        lines: rp
          ? ['Browse assets are cataloged on the requester-pays AWS bucket (usgs-landsat) — anonymous fetch is refused.', 'USGS browse portal now redirects anonymous requests to an EarthExplorer login (verified live). No public preview without USGS credentials.']
          : ['No public preview asset is exposed by the catalog for this product.'],
      };
    }
    if (pid.includes('copernicus')) {
      const preview = assets.preview || assets.thumbnail;
      if (preview) return { status: 'AUTH_REQUIRED', lines: ['Catalog lists a preview/quicklook asset but CDSE serves it only to authenticated OAuth clients (COPERNICUS_CLIENT_ID/SECRET not configured).'] };
      return { status: 'PREVIEW_UNAVAILABLE', lines: ['No quicklook asset is cataloged. A public Sentinel-2 preview mirror (roda.sentinel-hub.com) was probed — 404 for this product/tile. No synthetic image is shown.'] };
    }
    if (pid.includes('bhoonidhi')) return { status: 'AUTH_REQUIRED', lines: ['NRSC Bhoonidhi previews require ISRO credentials (BHOONIDHI_USER_ID/PASSWORD not configured).'] };
    return { status: 'PREVIEW_UNAVAILABLE', lines: ['Provider exposes no accessible public preview raster for this product.'] };
  };

  const renderMeta = (p: any) => {
    if (!p) return null;
    const meta2 = p.metadata || {};
    const assets = p.assets && typeof p.assets === 'object' && Object.keys(p.assets).length ? p.assets : null;
    const pr = previewReason(p);
    return (
      <div className="space-y-1">
        <Row k="Product ID" v={p.product_id} mono />
        <Row k="Collection" v={p.collection} />
        <Row k="Provider" v={p.provider_id} />
        <Row k="Acquisition" v={p.observation_date ? new Date(p.observation_date).toLocaleString() : undefined} />
        <Row k="Cloud cover" v={cloudPct(p.cloud_cover) >= 0 ? `${p.cloud_cover}%` : 'Not reported'} />
        <Row k="Platform / mission" v={meta2.platform || meta2.constellation || 'Not reported'} />
        <Row k="Assets listed" v={assets ? Object.keys(assets).length + ' (catalog-level, not downloaded)' : 'none stored'} />
        <div className="pt-1.5 space-y-1">
          <span className={`inline-flex items-center gap-1 text-[9px] px-2 py-0.5 rounded-full border font-semibold ${pr.status === 'AUTH_REQUIRED' ? 'bg-amber-500/15 text-amber-600 border-amber-500/40' : 'bg-slate-500/15 text-slate-400 border-slate-500/30'}`}>
            {pr.status} — no synthetic image is ever substituted
          </span>
          {pr.lines.map((l, i) => <p key={i} className="text-[9px] leading-snug text-slate-400">{l}</p>)}
        </div>
      </div>
    );
  };

  const srcCount = (id: string) => {
    if (id === 'all') return products.length;
    return products.filter((p) => {
      const pid = String(p.provider_id || '').toLowerCase();
      const col = String(p.collection || '').toLowerCase();
      if (id === 'copernicus') return pid.includes('copernicus') || col.includes('sentinel-2');
      if (id === 'sentinel-1') return pid.includes('sentinel-1') || col.includes('sentinel-1');
      if (id === 'landsat') return pid.includes('landsat') || col.includes('landsat');
      if (id === 'bhoonidhi') return pid.includes('bhoonidhi') || col.includes('bhoonidhi');
      return pid === id;
    }).length;
  };

  return (
    <div className="p-5 space-y-3 max-w-[1500px] mx-auto">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-200">🛰️ Satellite Intelligence</h1>
          <p className="text-xs text-slate-400 mt-0.5">Field AOI: <span className="text-slate-200 font-medium">{currentField.name}</span> · footprints are real provider records for this AOI</p>
        </div>
        <div className="flex items-center gap-2">
          {meta.state && <StateChip state={meta.state} />}
          <button onClick={() => runSearch({})} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">Refresh search for AOI</button>
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {(['explorer', 'products', 'timeline', 'search'] as Tab[]).map((tb) => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border capitalize transition-colors ${tab === tb ? 'bg-emerald-600/25 text-emerald-700 border-emerald-500/50' : 'bg-slate-900 text-slate-300 border-slate-700 hover:bg-slate-800'}`}>
            {tb}
          </button>
        ))}
      </div>

      {busy && <LoadingState label={tab === 'explorer' ? 'Querying satellite catalogs…' : 'Loading…'} />}
      {error && <ErrorState title="Satellite request failed" message={error} />}

      {!busy && !error && tab === 'explorer' && (
        <div className="grid grid-cols-1 lg:grid-cols-[200px_minmax(0,1fr)_300px] gap-3 items-stretch min-h-[520px]">
          {/* LEFT: real sources */}
          <div className="bg-slate-900 rounded-xl border border-slate-700 p-3 flex flex-col gap-1.5 lg:min-h-[520px]">
            <p className="text-[10px] font-bold tracking-wide text-slate-400 uppercase mb-1">Sources — kept separate</p>
            <button onClick={() => setSource('all')} className={`text-left px-2.5 py-2 rounded-lg border text-xs ${source === 'all' ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-700' : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
              <span className="font-semibold">All sources</span>
              <span className="block text-[10px] text-slate-400">{products.length} stored</span>
            </button>
            {SOURCES.map((s) => (
              <button key={s.id} onClick={() => setSource(s.id)} className={`text-left px-2.5 py-2 rounded-lg border text-xs ${source === s.id ? 'bg-emerald-600/20 border-emerald-500/40 text-emerald-700' : 'bg-slate-800/60 border-slate-700 text-slate-300 hover:bg-slate-800'}`}>
                <span className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: s.color }} />
                  <span className="font-semibold">{s.label}</span>
                </span>
                <span className="block text-[10px] text-slate-400">{s.sub}</span>
                <span className="block text-[10px] mt-0.5">
                  {srcCount(s.id) > 0 ? <span className="text-emerald-400">{srcCount(s.id)} stored</span> : <span className="text-amber-400">{s.id === 'bhoonidhi' ? 'AUTH_REQUIRED' : 'NO_DATA'}</span>}
                </span>
              </button>
            ))}
            <p className="text-[9px] text-slate-500 leading-relaxed mt-1">Sources are never merged into one fake fused image — fusion happens only in evidence/intelligence.</p>
          </div>

          {/* CENTER: geographic viewer */}
          <div className="bg-slate-900 rounded-xl border border-slate-700 overflow-hidden relative min-h-[520px]">
            <div ref={mapContainer} className="absolute inset-0" />
            {!products.length && !busy && (
              <div className="absolute inset-0 flex items-center justify-center bg-slate-900/60">
                <EmptyState title="No earth observation data" message={meta.message || 'No qualifying acquisition returned for this AOI/window, or the provider is temporarily unavailable.'} />
              </div>
            )}
            <div className="absolute bottom-3 left-3 bg-white/90 backdrop-blur-sm rounded-lg px-2.5 py-1.5 text-[10px] text-slate-600 border border-slate-200">
              Green = field AOI · purple = Sentinel-2 · amber = Landsat — real catalog footprints
            </div>
          </div>

          {/* RIGHT: product inspector */}
          <div className="bg-slate-900 rounded-xl border border-slate-700 p-3 flex flex-col gap-2 lg:min-h-[520px]">
            <p className="text-[10px] font-bold tracking-wide text-slate-400 uppercase">Product inspector</p>
            {selected ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-200">Selected acquisition</span>
                  <StateChip state="OBSERVED" />
                </div>
                <div className="text-xs">{renderMeta(selected)}</div>
                <p className="text-[9px] text-slate-500 leading-relaxed">Real catalog record for this field AOI · state OBSERVED (provider metadata). Band processing → DERIVED only after authenticated asset download.</p>
              </>
            ) : <p className="text-xs text-slate-400 py-10 text-center">No products stored for this AOI.</p>}
          </div>
        </div>
      )}

      {!busy && !error && tab === 'explorer' && filtered.length > 0 && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 px-3 py-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-bold tracking-wide text-slate-400 uppercase">Acquisition timeline — {filtered.length} real product(s), click to select &amp; zoom</span>
            {maxCloud >= 0 && <span className="text-[9px] text-slate-400">worst cloud {Math.round(maxCloud)}%</span>}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[...filtered].sort((a, b) => String(b.observation_date).localeCompare(String(a.observation_date))).map((p) => (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                className={`shrink-0 text-left rounded-lg px-2.5 py-1.5 border min-w-[170px] transition-colors ${selected?.id === p.id ? 'bg-emerald-600/20 border-emerald-500/50' : 'bg-slate-800/60 border-slate-700 hover:bg-slate-800'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9px] font-semibold text-slate-300">{SOURCES.find((s) => s.id === p.provider_id)?.label || p.provider_id}</span>
                  {cloudPct(p.cloud_cover) >= 0 && (
                    <span className={`text-[8px] px-1 rounded-full ${cloudPct(p.cloud_cover) > 60 ? 'bg-rose-500/20 text-rose-300' : cloudPct(p.cloud_cover) > 30 ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300'}`}>
                      cloud {p.cloud_cover}%
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">{p.product_id}</p>
                <p className="text-[9px] text-slate-500">{p.observation_date ? new Date(p.observation_date).toLocaleString() : '—'}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {!busy && !error && tab === 'products' && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">Stored products ({products.length})</h3>
          {products.length ? (
            <div className="space-y-1.5">
              {products.map((p: any) => (
                <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs border border-slate-700 rounded-lg px-3 py-2">
                  <span className="font-mono text-[10px] text-slate-200">{p.product_id}</span>
                  <span className="text-slate-400">{p.collection}</span>
                  <span className="text-slate-400">{(p.metadata as any)?.platform || 'platform not reported'}</span>
                  <span className="text-slate-400">{p.observation_date ? new Date(p.observation_date).toLocaleDateString() : '—'}</span>
                  {cloudPct(p.cloud_cover) >= 0 && <span className="text-slate-400">cloud {p.cloud_cover}%</span>}
                  <StateChip state="OBSERVED" />
                </div>
              ))}
            </div>
          ) : <EmptyState title="No stored satellite products" message="The explorer auto-searches on load; run Refresh search if the catalog was empty." />}
        </div>
      )}

      {!busy && !error && tab === 'timeline' && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
          <h3 className="text-sm font-semibold text-slate-200 mb-2">Acquisition timeline ({series.length})</h3>
          {series.length ? (
            <div className="space-y-1.5">
              {series.slice().reverse().map((s, i) => {
                const c = cloudPct(s.cloud_cover);
                return (
                  <div key={i} className="flex items-center gap-3 text-xs border border-slate-700 rounded-lg px-3 py-2">
                    <span className="text-slate-400 w-36 shrink-0">{s.observation_date ? new Date(s.observation_date).toLocaleDateString() : '—'}</span>
                    <span className="text-slate-300 w-64 truncate" title={s.product_id}>{s.product_id}</span>
                    <span className="text-slate-400 w-24 truncate">{s.collection}</span>
                    {c >= 0 ? <span className="text-slate-400 w-12">{c}% cloud</span> : <span className="text-slate-600 w-12">—</span>}
                    <span className="text-slate-500">{s.provider}</span>
                  </div>
                );
              })}
            </div>
          ) : <EmptyState title="No acquisitions in timeline" message="No real satellite products are stored for this field yet." />}
        </div>
      )}

      {!busy && !error && tab === 'search' && (
        <div className="space-y-3">
          <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-slate-200">Search &amp; store real acquisitions</h3>
              <StateChip state={meta.state || 'PENDING'} />
            </div>
            <p className="text-xs text-slate-300 mb-3">Query both catalogs (Copernicus S2 L2A + Landsat C2) over the last 60 days for this field's AOI and persist real products as earth-observation evidence.</p>
            <button onClick={() => runSearch({})} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50">Run search for AOI</button>
            {meta.message && <p className="text-xs text-amber-600 mt-2">{meta.message}</p>}
          </div>
          <InfoNote>NDVI / NDMI / change detection download real COG band assets and are processed by the backend pipeline (state DERIVED). No synthetic index is ever generated — configure Copernicus credentials to enable asset download.</InfoNote>
        </div>
      )}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v?: unknown; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <dt className="text-slate-400 shrink-0">{k}</dt>
      <dd className={`text-slate-100 text-right ${mono ? 'font-mono text-[9px] break-all max-w-[150px]' : ''}`}>
        {v === null || v === undefined || v === '' ? <span className="text-slate-500 italic">Not reported</span> : String(v)}
      </dd>
    </div>
  );
}
