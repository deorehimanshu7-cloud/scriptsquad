import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';
import { Panel, StateChip, LoadingState, ErrorState, EmptyState, GenericTable, InfoNote, Value } from '@/components/ui/kit';

type Section = 'current' | 'forecast' | 'history' | 'anomalies';

function fmt(v: unknown, suffix = '') {
  if (v === null || v === undefined || v === '') return <span className="text-slate-500 italic">Not reported</span>;
  return <span>{typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(v)}{suffix}</span>;
}

function VarCell({ label, v, suffix, unit }: { label: string; v: unknown; suffix?: string; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between py-1.5 border-b border-slate-800/70 last:border-0">
      <span className="text-xs text-slate-400">{label}</span>
      <span className="text-sm font-medium text-slate-100">{fmt(v, suffix)}{unit ? <span className="text-slate-500 text-xs ml-0.5">{unit}</span> : null}</span>
    </div>
  );
}

function metricSummary(o: Record<string, unknown>): string {
  const prefer = ['temperature_2m', 'temperature_2m_max', 'precipitation', 'precipitation_sum', 'relative_humidity_2m', 'wind_speed_10m'];
  const parts = prefer.filter((k) => o[k] !== null && o[k] !== undefined && typeof o[k] === 'number').map((k) => `${k.replace(/_/g, ' ')} ${o[k]}`);
  return parts.length ? parts.slice(0, 4).join(' · ') : 'values stored';
}

export default function WeatherPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [section, setSection] = useState<Section>('current');
  const [state, setState] = useState<{ loading: boolean; error?: string }>({ loading: false });
  const [data, setData] = useState<any>(null);

  const base = currentField ? `/fields/${currentField.id}/weather` : null;

  async function load() {
    if (!base) return;
    setState({ loading: true, error: undefined });
    try {
      const r = await api.get<any>(`${base}/${section}`);
      setData(r);
    } catch (e: any) {
      setState({ loading: false, error: e?.response?.data?.error?.message || e?.message || 'Request failed' });
      return;
    }
    setState({ loading: false });
  }

  useEffect(() => { setData(null); if (base) load(); }, [base, section]);

  if (!currentField) {
    return <EmptyState title="No field selected" message="Select a field from the top bar to load its weather evidence." />;
  }

  const payload = data?.data ?? null;
  const statusState = data?.state;
  const semantics = data?.semantics;
  const provider = data?.provider;
  const message = data?.message;
  const showUnavailable = ['UNAVAILABLE', 'AUTH_REQUIRED', 'RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR', 'NO_DATA'].includes(statusState);

  const current = payload && payload.current ? payload.current : payload;
  const daily: Record<string, unknown>[] = data?.forecast && Array.isArray(data.forecast) ? data.forecast
    : payload && Array.isArray(payload.daily) ? payload.daily
    : Array.isArray(payload) ? payload : [];

  const tabs: { id: Section; label: string }[] = [
    { id: 'current', label: 'Current' },
    { id: 'forecast', label: 'Forecast' },
    { id: 'history', label: 'History' },
    { id: 'anomalies', label: 'Anomalies' },
  ];

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-slate-200">{t('nav.weather')}</h1>
          <p className="text-xs text-slate-400 mt-0.5">Field: <span className="text-slate-200">{currentField.name}</span></p>
        </div>
        <div className="flex items-center gap-2">
          {statusState && <StateChip state={statusState} />}
          {semantics && <span className="text-[11px] px-2 py-0.5 rounded-md bg-slate-700/60 text-slate-300 uppercase tracking-wide">semantics: {semantics}</span>}
          {provider && <span className="text-[11px] text-slate-400">provider: {provider}</span>}
        </div>
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {tabs.map((tb) => (
          <button key={tb.id} onClick={() => setSection(tb.id)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${section === tb.id ? 'bg-emerald-600/30 text-emerald-200 border-emerald-500/50' : 'bg-slate-800 text-slate-300 border-slate-700 hover:bg-slate-700'}`}>
            {tb.label}
          </button>
        ))}
        <button onClick={load} disabled={state.loading}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-sky-600/30 text-sky-200 border border-sky-500/50 hover:bg-sky-600/40 disabled:opacity-50">
          {state.loading ? 'Fetching…' : '⟳ Refresh'}
        </button>
      </div>

      {state.loading && <LoadingState label="Fetching from weather provider…" />}
      {state.error && <ErrorState title="Weather request failed" message={state.error} onRetry={load} />}

      {!state.loading && !state.error && showUnavailable && (
        <ErrorState
          title={statusState === 'AUTH_REQUIRED' ? 'Authentication required' : `Weather data ${statusState === 'NO_DATA' ? 'not found' : 'unavailable'}`}
          message={message || `Provider returned ${statusState}. No fabricated weather values are ever shown.`}
          onRetry={load}
        />
      )}

      {!state.loading && !state.error && data && (
        <>
          {section === 'current' && (
            <div className="grid md:grid-cols-2 gap-4">
              <Panel title="Current conditions">
                {current ? (
                  <div className="grid grid-cols-2 gap-x-6">
                    <VarCell label="Temperature" v={(current as any).temperature_2m} suffix="°C" />
                    <VarCell label="Feels like" v={(current as any).apparent_temperature} suffix="°C" />
                    <VarCell label="Humidity" v={(current as any).relative_humidity_2m} suffix="%" />
                    <VarCell label="Precipitation" v={(current as any).precipitation} suffix="mm" />
                    <VarCell label="Wind" v={(current as any).wind_speed_10m} suffix="km/h" />
                    <VarCell label="Weather code" v={(current as any).weather_code} />
                    {(current as any).time && <div className="col-span-2 text-[11px] text-slate-400 pt-1">Observed at {new Date((current as any).time).toLocaleString()}</div>}
                  </div>
                ) : (
                  <EmptyState title="No current observation stored" message="Refresh to call the weather provider for this field's coordinates." />
                )}
              </Panel>
              <Panel title="Semantics">
                <ul className="text-xs text-slate-300 space-y-2">
                  <li><b className="text-slate-200">MODEL_DERIVED</b> — Open-Meteo output is numerical model output, never a physical on-site observation.</li>
                  <li><b className="text-slate-200">PREDICTED</b> — forecast horizon.</li>
                  <li><b className="text-slate-200">REANALYSIS</b> — ERA5/ERA5-Land historical reanalysis.</li>
                  <li>Precipitation/rainfall of <code>null</code> is rendered <i>Not reported</i>, never as <code>0 mm</code>.</li>
                </ul>
              </Panel>
            </div>
          )}

          {section === 'forecast' && (
            <Panel title="Forecast (7 day)" right={<StateChip state="PREDICTED" />}>
              {daily.length ? (
                <GenericTable rows={daily as Record<string, unknown>[]} />
              ) : <EmptyState title="No forecast rows" message="Refresh to call the provider. Forecast is model output (PREDICTED), not observation." />}
            </Panel>
          )}

          {section === 'history' && (
            <Panel title="History (ERA5 reanalysis)" right={<StateChip state="REANALYSIS" />}>
              {data?.note && <InfoNote>{data.note}</InfoNote>}
              <div className="mt-3">
                {daily.length ? (
                  <GenericTable rows={daily as Record<string, unknown>[]} />
                ) : <EmptyState title="No history rows stored" message="Historical weather is ERA5/ERA5-Land reanalysis retrieved through Open-Meteo Archive — never presented as physical observation." />}
              </div>
            </Panel>
          )}

          {section === 'anomalies' && (
            <Panel title="Weather anomalies">
              {Array.isArray(payload) && payload.length ? (
                <div className="space-y-2">
                  {payload.map((row: any, i: number) => (
                    <div key={i} className="border border-slate-700 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
                      <div className="text-xs text-slate-300">
                        <div className="font-semibold text-slate-200">{row.type || row.source || 'anomaly'}</div>
                        <div className="text-slate-400 mt-0.5">{metricSummary(row.measurement || row)}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[11px] text-slate-400">{row.observation_time ? new Date(row.observation_time).toLocaleString() : '—'}</div>
                        <StateChip state={row.state} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="No weather anomalies" message="Anomaly analysis is derived from stored history once enough records exist — nothing is inferred from a single reading." />}
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
