import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';
import { Panel, StateChip, LoadingState, ErrorState, EmptyState, GenericTable, InfoNote } from '@/components/ui/kit';

type Tab = 'soil' | 'terrain' | 'water' | 'crop';

export default function EnvironmentPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const fieldId = currentField?.id;
  const [tab, setTab] = useState<Tab>('soil');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [payload, setPayload] = useState<any>(null);

  async function load() {
    if (!fieldId) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.get<any>(`/fields/${fieldId}/${tab}`);
      setPayload(r);
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { setBusy(false); }
  }

  async function fetchProvider() {
    if (!fieldId || (tab !== 'soil' && tab !== 'terrain')) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.post<any>(`/fields/${fieldId}/${tab}/fetch`, {});
      setNotice(`${tab === 'soil' ? 'SoilGrids' : 'DEM'} response: ${r.provider_status || 'ok'}${r.message ? ` — ${r.message}` : ''}`);
      load();
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { setBusy(false); }
  }

  async function createCrop(e: React.FormEvent) {
    e.preventDefault();
    if (!fieldId) return;
    const fd = new FormData(e.target as HTMLFormElement);
    setError(null);
    try {
      await api.post<any>(`/fields/${fieldId}/crop`, {
        crop_type: String(fd.get('crop_type') || ''), variety: String(fd.get('variety') || '') || undefined,
        season: String(fd.get('season') || '') || undefined, sowing_date: String(fd.get('sowing_date') || '') || undefined,
      });
      load();
    } catch (err: any) { setError(err?.response?.data?.error?.message || err?.message); }
  }

  useEffect(() => { setPayload(null); if (fieldId) load(); /* eslint-disable-next-line */ }, [fieldId, tab]);

  if (!currentField) {
    return <EmptyState title="No field selected" message="Select a field to inspect its soil, terrain, water and crop state." />;
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'soil', label: t('nav.soil') }, { id: 'terrain', label: t('nav.terrain') },
    { id: 'water', label: t('nav.water') }, { id: 'crop', label: t('nav.crop') },
  ];

  const soilProps = payload?.data?.properties || [];
  const terrainState = payload?.data;
  const waterObs = payload?.data?.observations || [];
  const crop = payload?.data;

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-200">Environment</h1>
          <p className="text-xs text-slate-400 mt-0.5">Field: <span className="text-slate-200">{currentField.name}</span> — every property carries value, unit, state, source and provenance</p>
        </div>
        <div className="flex items-center gap-2">
          {payload?.state && <StateChip state={payload.state} />}
          {(tab === 'soil' || tab === 'terrain') && (
            <button onClick={fetchProvider} disabled={busy} className="px-3 py-1.5 rounded-lg text-sm bg-emerald-600/30 text-emerald-200 border border-emerald-500/50 hover:bg-emerald-600/40 disabled:opacity-50">
              {busy ? 'Fetching…' : `Fetch ${tab === 'soil' ? 'modelled estimates' : 'DEM elevation'}`}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium capitalize border transition-colors ${tab === tb.id ? 'bg-emerald-600/30 text-emerald-200 border-emerald-500/50' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}>
            {tb.label}
          </button>
        ))}
      </div>

      {busy && <LoadingState label="Loading…" />}
      {error && <ErrorState title="Request failed" message={error} onRetry={load} />}
      {notice && <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{notice}</div>}

      {!busy && !error && tab === 'soil' && (
        <div className="space-y-4">
          <InfoNote>
            Soil properties come from SoilGrids v2 (ISRIC) modelled estimates where fetched. They are labelled <b>ESTIMATED</b> with model uncertainty —
            SoilGrids is not an on-site measurement. Without a physical pH/EC sensor the values read <b>UNKNOWN</b>; the system never invents them.
          </InfoNote>
          {soilProps.length ? (
            <Panel title={`Soil properties (${soilProps.length})`}>
              <div className="grid md:grid-cols-2 gap-2">
                {soilProps.map((p: any, i: number) => (
                  <div key={i} className="border border-slate-700 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-100 capitalize">{p.property.replace(/_/g, ' ')}</p>
                      <p className="text-[11px] text-slate-500 truncate">{p.source || '—'} · {p.timestamp ? new Date(p.timestamp).toLocaleDateString() : '—'}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-medium text-slate-100">
                        {p.value === null || p.value === undefined ? <span className="text-slate-500 italic">Unknown</span> : `${p.value}${p.unit ? ` ${p.unit}` : ''}`}
                      </p>
                      <div className="flex justify-end mt-0.5"><StateChip state={p.state} /></div>
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          ) : (
            <Panel title="Soil properties">
              <EmptyState
                title="Soil state UNKNOWN"
                message={'No soil properties are stored for this field yet.\nFetch modelled estimates (ESTIMATED) from SoilGrids, or register a field sensor — a physical reading is the only OBSERVED source.'}
              />
            </Panel>
          )}
        </div>
      )}

      {!busy && !error && tab === 'terrain' && (
        <Panel title="Terrain">
          {terrainState?.elevation_m != null ? (
            <div className="space-y-2">
              <div className="flex items-end justify-between border border-slate-700 rounded-lg px-4 py-3">
                <div>
                  <p className="text-xs text-slate-400">Mean elevation at field centroid</p>
                  <p className="text-2xl font-bold text-slate-50">{terrainState.elevation_m} <span className="text-sm text-slate-400 font-normal">m</span></p>
                </div>
                <div className="text-right">
                  <StateChip state={terrainState.state} />
                  <p className="text-[11px] text-slate-500 mt-1">source: {terrainState.source || 'DEM sample'}</p>
                </div>
              </div>
              {terrainState.note && <InfoNote>{terrainState.note}</InfoNote>}
              {terrainState.products?.length > 0 && <GenericTable rows={terrainState.products as Record<string, unknown>[]} />}
            </div>
          ) : (
            <EmptyState
              title="Terrain data unavailable"
              message={terrainState?.note || 'No DEM elevation stored. Use “Fetch DEM elevation” to sample real elevation for this field — arbitrary elevation values are never generated.'}
            />
          )}
        </Panel>
      )}

      {!busy && !error && tab === 'water' && (
        <Panel title="Water">
          {payload?.message && <InfoNote>{payload.message}</InfoNote>}
          {waterObs.length ? (
            <div className="mt-3"><GenericTable rows={waterObs as Record<string, unknown>[]} /></div>
          ) : (
            <div className="mt-3">
              <EmptyState
                title="NO_DATA — water observations require a real source"
                message={'National datasets (CGWB groundwater, India-WRIS) are credential-gated and no verified credential-free endpoint is integrated yet.\nGroundwater depth is NEVER fabricated or estimated: it stays UNKNOWN until a real observation exists.'}
              />
            </div>
          )}
        </Panel>
      )}

      {!busy && !error && tab === 'crop' && (
        <div className="space-y-4">
          <Panel title="Register crop cycle">
            <form onSubmit={createCrop} className="flex flex-wrap gap-2 items-end">
              <Field label="Crop type" name="crop_type" placeholder="e.g. soybean" required />
              <Field label="Variety" name="variety" />
              <Field label="Season" name="season" placeholder="e.g. kharif" />
              <Field label="Sowing date" name="sowing_date" type="date" />
              <button type="submit" className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-slate-200 hover:bg-emerald-500">Register cycle</button>
            </form>
          </Panel>
          {crop?.latest && (
            <Panel title="Latest crop cycle" right={<StateChip state={crop.state} />}>
              <div className="text-xs space-y-1">
                <p className="text-slate-100 font-semibold">{crop.latest.crop_type}{crop.latest.variety ? ` · ${crop.latest.variety}` : ''}{crop.latest.season ? ` · ${crop.latest.season}` : ''}</p>
                {crop.latest.sowing_date && <p className="text-slate-400">Sown {new Date(crop.latest.sowing_date).toLocaleDateString()}</p>}
                <p className="text-slate-500">Cycle id: {crop.latest.id}</p>
              </div>
              {crop.states?.length > 0 && (
                <div className="mt-3"><GenericTable rows={crop.states as Record<string, unknown>[]} /></div>
              )}
            </Panel>
          )}
          {(!crop?.latest && !crop?.cycles?.length) && (
            <EmptyState title="No crop registered" message="Crop state stays UNKNOWN until a cycle is registered or an observation is recorded — crop state is never guessed." />
          )}
          {crop?.cycles?.length > 1 && (
            <Panel title={`All cycles (${crop.cycles.length})`}>
              <GenericTable rows={crop.cycles as Record<string, unknown>[]} />
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, name, type = 'text', placeholder, required }: { label: string; name: string; type?: string; placeholder?: string; required?: boolean }) {
  return (
    <label className="text-xs text-slate-400 block">
      {label}
      <input type={type} name={name} required={required} placeholder={placeholder}
        className="mt-1 w-44 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-600" />
    </label>
  );
}
