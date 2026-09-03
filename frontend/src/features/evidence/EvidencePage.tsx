import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

type EvidenceLayer = 'overview' | 'satellite' | 'sensors' | 'weather' | 'water' | 'soil' | 'terrain' | 'crop' | 'farmer' | 'history' | 'contradiction' | 'quality';

/**
 * Domain classifier. AGRIFUR domains are separated by evidence contract, not
 * by a single coarse source column: weather is ENVIRONMENT, DEM elevation is
 * TERRAIN, soil/crop are distinguished by provider + measurement semantics.
 * Weather records can therefore never surface under Terrain.
 */
function domainOf(e: any): string {
  const src = String(e.source || '').toUpperCase();
  const prov = String(e.provider || '').toLowerCase();
  const m: any = e.measurement || {};
  if (src === 'PHYSICAL_HARDWARE') return 'sensors';
  if (src === 'EARTH_OBSERVATION') return 'satellite';
  if (src === 'WATER') return 'water';
  if (src === 'FARMER_INPUT') return 'farmer';
  if (src === 'HISTORY') return 'history';
  if (src === 'TERRAIN') return 'terrain';
  if (prov.includes('elevation') || prov.includes('dem') || m.elevation_m !== undefined) return 'terrain';
  if (src === 'ENVIRONMENT') return 'weather';
  if (src === 'AGRICULTURE') {
    if (prov.includes('soil') || m.property !== undefined) return 'soil';
    return 'crop';
  }
  if (src === 'SIMULATION_VIRTUAL') return 'history';
  return (src || 'unknown').toLowerCase();
}

const stateChip: Record<string, string> = {
  OBSERVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DERIVED: 'bg-blue-50 text-blue-700 border-blue-200',
  ESTIMATED: 'bg-amber-50 text-amber-700 border-amber-200',
  MODEL_DERIVED: 'bg-sky-50 text-sky-700 border-sky-200',
  REANALYSIS: 'bg-violet-50 text-violet-700 border-violet-200',
  MODELLED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  PREDICTED: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200',
  UNKNOWN: 'bg-slate-100 text-slate-500 border-slate-200',
};

function summarize(e: any): string {
  const m: any = e.measurement || {};
  const d = domainOf(e);
  try {
    if (d === 'weather') {
      if (m?.current?.temperature_c !== undefined) return `${m.current.temperature_c}°C, ${m.current.relative_humidity_2m ?? '?'}% RH @ ${m.provider || 'open-meteo'}`;
      if (m?.semantics === 'REANALYSIS') return `ERA5 reanalysis — ${(m.daily || []).length} daily records`;
      if (m?.daily) return `Forecast — ${m.daily.length} days`;
    }
    if (d === 'satellite') {
      const cloud = m?.properties?.['eo:cloud_cover'];
      return `${m.product_id || e.provider}${cloud !== undefined ? ` · cloud ${cloud}%` : ''}`;
    }
    if (d === 'soil') return `${m.property || 'property'}: ${m.value}${m.unit ? ' ' + m.unit : ''}${m.depth ? ' @ ' + m.depth : ''}`;
    if (d === 'terrain') return m.elevation_m !== undefined ? `elevation ${m.elevation_m} m` : JSON.stringify(m);
    if (d === 'sensors') return `${m.sensor_type || 'sensor'}: ${m.value}${m.unit ? ' ' + m.unit : ''}${m.depth_m !== undefined ? ' @ ' + (m.depth_m * 100) + ' cm' : ''}`;
    if (d === 'crop') return m.crop_type || JSON.stringify(m);
    return JSON.stringify(m).slice(0, 180);
  } catch { return JSON.stringify(m).slice(0, 180); }
}

const layerMeta: { key: EvidenceLayer; icon: string; label: string; color: string }[] = [
  { key: 'overview', icon: '📊', label: 'Overview', color: 'bg-slate-600' },
  { key: 'satellite', icon: '🛰️', label: 'Satellite', color: 'bg-violet-500' },
  { key: 'sensors', icon: '📡', label: 'Sensors', color: 'bg-cyan-600' },
  { key: 'weather', icon: '🌤️', label: 'Weather', color: 'bg-yellow-500' },
  { key: 'water', icon: '💧', label: 'Water', color: 'bg-blue-500' },
  { key: 'soil', icon: '🟤', label: 'Soil', color: 'bg-amber-700' },
  { key: 'terrain', icon: '⛰️', label: 'Terrain', color: 'bg-orange-600' },
  { key: 'crop', icon: '🌾', label: 'Crop', color: 'bg-green-600' },
  { key: 'farmer', icon: '👨‍🌾', label: 'Farmer', color: 'bg-teal-600' },
  { key: 'history', icon: '📈', label: 'History', color: 'bg-slate-500' },
  { key: 'contradiction', icon: '⚡', label: 'Contradictions', color: 'bg-rose-600' },
  { key: 'quality', icon: '✅', label: 'Data Quality', color: 'bg-emerald-600' },
];

const whyUnknown: Record<string, string> = {
  satellite: 'No earth-observation product (Sentinel-2 / Sentinel-1 / Landsat) has been stored for this field yet.',
  sensors: 'No registered sensor has submitted observations for this field. Physical telemetry only — never fabricated.',
  weather: 'No weather dataset (current/forecast/reanalysis) has been retrieved for this field.',
  water: 'No water evidence (surface / groundwater / irrigation) is recorded for this field.',
  soil: 'No field soil observation or applicable model estimate (e.g. SoilGrids) is stored.',
  terrain: 'No DEM elevation sample exists. Fetch from Environment → Terrain — arbitrary elevation values are never generated.',
  crop: 'No declared or observed crop cycle is recorded for this field.',
  farmer: 'No farmer observations are recorded for this field.',
  history: 'No historical evidence archive entries exist for this field.',
};

export default function EvidencePage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [activeLayer, setActiveLayer] = useState<EvidenceLayer>('overview');
  const [evidence, setEvidence] = useState<any[]>([]);
  const [wm, setWm] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // FIELD ISOLATION: clear the previous field's evidence + world model before fetching.
    setEvidence([]);
    setWm(null);
    if (!currentField) return;
    setLoading(true);
    const pid = currentField.id;
    api.get<{ success: boolean; data: any[] }>('/fields/' + pid + '/evidence')
      .then(r => { if (r.success) setEvidence(r.data); }).catch(() => {});
    api.get<{ success: boolean; data: any }>('/fields/' + pid + '/world-model')
      .then(r => { if (r.success) setWm(r.data); }).catch(() => {})
      .finally(() => setLoading(false));
  }, [currentField]);

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">📊</div>
      <h2 className="text-xl font-semibold text-slate-800 mb-2">{t('evidence.title')}</h2>
      <p className="text-slate-500">{t('world.no_field')}</p>
    </div>
  );

  const byDomain: Record<string, any[]> = {};
  for (const e of evidence) { const d = domainOf(e); (byDomain[d] = byDomain[d] || []).push(e); }

  const active = activeLayer === 'overview' ? null : activeLayer;
  const rows = active ? (byDomain[active] || []) : evidence;
  const contradictions = wm?.contradictions || [];
  const qualityAssessed = evidence.filter((e: any) => e.quality && (typeof e.quality?.completeness === 'number' || typeof e.quality?.validity === 'number'));

  return (
    <div className="h-full flex flex-col bg-slate-100 overflow-hidden">
      <div className="px-6 pt-5 pb-3 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t('evidence.title')}</h1>
            <p className="text-xs text-slate-500 mt-0.5">{currentField.name} · {typeof currentField.area_hectares === 'number' && isFinite(currentField.area_hectares) ? currentField.area_hectares.toFixed(2) + ' ha' : 'AREA UNKNOWN'} · {evidence.length} evidence records · <span className="text-slate-400">every record carries source/provider/state/provenance — domains never mix</span></p>
          </div>
          {loading && <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3">
          {layerMeta.map(l => {
            const count = l.key === 'overview' ? evidence.length : (byDomain[l.key] || []).length;
            return (
              <button key={l.key} onClick={() => setActiveLayer(l.key)}
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors flex items-center gap-1.5 ${activeLayer === l.key ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-400'}`}>
                <span>{l.icon}</span><span>{l.label}</span>
                <span className={`px-1.5 rounded-full text-[10px] ${activeLayer === l.key ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'}`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeLayer === 'overview' && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-2 bg-white rounded-xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Evidence Fabric — by domain</h3>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {layerMeta.filter(l => l.key !== 'overview' && l.key !== 'contradiction' && l.key !== 'quality').map(l => {
                  const list = byDomain[l.key] || [];
                  const states = [...new Set(list.map((e: any) => e.state))];
                  const freshest = list.length ? new Date(list[0].observation_time).toLocaleDateString() : null;
                  return (
                    <div key={l.key} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 mb-1">
                        <span className={`w-2 h-2 rounded-full ${l.color}`} /><span>{l.label}</span>
                      </div>
                      {list.length === 0 ? (
                        <p className="text-[11px] text-slate-400 leading-snug">{whyUnknown[l.key]}</p>
                      ) : (
                        <>
                          <div className="text-lg font-bold text-slate-800">{list.length} <span className="text-xs font-normal text-slate-400">record{list.length > 1 ? 's' : ''}</span></div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {states.map(s => <span key={s} className={`px-1.5 py-0.5 rounded border text-[9px] font-medium ${stateChip[s] || stateChip.UNKNOWN}`}>{s}</span>)}
                          </div>
                          <p className="text-[10px] text-slate-400 mt-1">freshest {freshest}</p>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
                <h4 className="text-xs font-semibold text-amber-800 mb-1">What is UNKNOWN — and why</h4>
                <ul className="space-y-1">
                  {layerMeta.filter(l => (byDomain[l.key] || []).length === 0 && whyUnknown[l.key]).map(l => (
                    <li key={l.key} className="text-[11px] text-amber-700"><span className="font-semibold">{l.label}:</span> {whyUnknown[l.key]}</li>
                  ))}
                  {(Object.values(byDomain).flat().length === 0) && <li className="text-[11px] text-amber-700">No evidence stored for this field yet — run field provider fetches to begin the evidence fabric.</li>}
                </ul>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-800 mb-3">Contradictions</h3>
              {contradictions.length === 0 ? (
                <p className="text-[12px] text-slate-400">None detected — contradiction detection runs on actual cross-domain disagreement only; it never fabricates conflicts.</p>
              ) : contradictions.slice(0, 5).map((c: any) => (
                <div key={c.id} className="mb-2 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-[11px] text-rose-700">
                  <span className="font-semibold">{c.type}</span> — {c.rationale || c.description || ''}
                </div>
              ))}
              <div className="mt-4 pt-3 border-t border-slate-100">
                <h4 className="text-xs font-semibold text-slate-700 mb-1">Record quality</h4>
                <p className="text-[11px] text-slate-500">{qualityAssessed.length} of {evidence.length} records carry a computed quality assessment · aggregate quality scoring requires a calibrated quality model.</p>
              </div>
            </div>
          </div>
        )}

        {activeLayer === 'contradiction' && (
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-800 mb-3">⚡ Contradiction Lab</h3>
            {contradictions.length === 0 ? (
              <p className="text-xs text-slate-400">No contradictions detected from the evidence fabric. Contradiction detection runs on real cross-domain disagreement (e.g. satellite vegetation decline vs. sensor moisture normal) — none are invented.</p>
            ) : contradictions.map((c: any) => (
              <div key={c.id} className="mb-2 rounded-lg border border-rose-200 bg-rose-50 p-3">
                <div className="text-xs font-semibold text-rose-700">{c.type}</div>
                <p className="text-[11px] text-rose-600 mt-0.5">{c.rationale || c.description}</p>
              </div>
            ))}
          </div>
        )}

        {activeLayer === 'quality' && (
          <div className="bg-white rounded-xl border border-slate-200 p-5 max-w-3xl">
            <h3 className="text-sm font-semibold text-slate-800 mb-4">Data Quality</h3>
            <div className="grid grid-cols-3 gap-4 mb-4">
              {[['Total records', evidence.length], ['Quality assessed', qualityAssessed.length], ['Not assessed', evidence.length - qualityAssessed.length]].map(([lab, n]) => (
                <div key={String(lab)} className="rounded-lg bg-slate-50 border border-slate-200 p-4">
                  <div className="text-[11px] text-slate-500 mb-1">{lab}</div>
                  <div className="text-2xl font-bold text-slate-800">{n}</div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-slate-500 leading-relaxed">Per-record quality (completeness / validity / range plausibility) is stored with each evidence item when the pipeline computes it. Aggregate scoring is reported as NOT_ASSESSED until a calibrated quality model exists — never as a fake percentage.</p>
          </div>
        )}

        {active && activeLayer !== 'contradiction' && activeLayer !== 'quality' && (
          <div className="max-w-5xl">
            {rows.length === 0 ? (
              <div className="bg-white rounded-xl border border-slate-200 p-8 text-center">
                <div className="text-4xl mb-3">{layerMeta.find(l => l.key === activeLayer)?.icon}</div>
                <p className="text-sm font-medium text-slate-600 mb-1">No {activeLayer} evidence available</p>
                <p className="text-xs text-slate-400 max-w-lg mx-auto leading-relaxed">{whyUnknown[activeLayer]}</p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {rows.map((e: any) => (
                  <div key={e.id} className="bg-white rounded-xl border border-slate-200 p-4 flex items-start gap-3 hover:border-emerald-300 transition-colors">
                    <div className="text-xl mt-0.5">{layerMeta.find(l => l.key === domainOf(e))?.icon || '📄'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-slate-800">{layerMeta.find(l => l.key === domainOf(e))?.label || e.source}</span>
                        <span className={`px-1.5 py-0.5 rounded border text-[10px] font-medium ${stateChip[e.state] || stateChip.UNKNOWN}`}>{e.state}</span>
                        <span className="text-[10px] text-slate-400">provider: {e.provider || 'unknown'} · source: {e.source}</span>
                      </div>
                      <p className="text-[12px] text-slate-700 mt-1 font-mono">{summarize(e)}</p>
                      <p className="text-[10px] text-slate-400 mt-1">observed {new Date(e.observation_time).toLocaleString()} · retrieved {new Date(e.retrieved_at).toLocaleString()}{e.depth_meters != null ? ` · depth ${e.depth_meters} m` : ''}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="text-[10px] text-slate-400 block">id</span>
                      <span className="text-[10px] text-slate-500 font-mono">{e.id.slice(0, 8)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
