import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

type IntelTab = 'anomalies' | 'risks' | 'uncertainty' | 'contradictions' | 'next';

const stateChip: Record<string, string> = {
  HIGH: 'bg-rose-50 text-rose-700 border-rose-200',
  MEDIUM: 'bg-amber-50 text-amber-700 border-amber-200',
  LOW: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CRITICAL: 'bg-rose-100 text-rose-800 border-rose-300',
  AVAILABLE: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MISSING: 'bg-slate-100 text-slate-500 border-slate-200',
  NOT_ASSESSED: 'bg-slate-100 text-slate-500 border-slate-200',
};

function sevChip(sev: string) { return stateChip[String(sev || '').toUpperCase()] || stateChip.NOT_ASSESSED; }

const tabs: { key: IntelTab; icon: string; label: string }[] = [
  { key: 'anomalies', icon: '🔍', label: 'Anomalies' },
  { key: 'risks', icon: '⚠️', label: 'Risks' },
  { key: 'uncertainty', icon: '❓', label: 'Uncertainty' },
  { key: 'contradictions', icon: '⚡', label: 'Contradictions' },
  { key: 'next', icon: '🎯', label: 'Next Best Observation' },
];

export default function IntelligencePage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [activeTab, setActiveTab] = useState<IntelTab>('anomalies');
  const [wm, setWm] = useState<any>(null);
  const [intel, setIntel] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (fieldId: string) => {
    setLoading(true);
    setError(null);
    await Promise.all([
      api.get<{ success: boolean; data: any }>('/fields/' + fieldId + '/world-model')
        .then(r => { if (r.success) setWm(r.data); }).catch(() => {}),
      api.get<{ success: boolean; data: any }>('/fields/' + fieldId + '/intelligence')
        .then(r => { if (r.success) setIntel(r.data); }).catch(() => {}),
    ]);
    setLoading(false);
  }, []);

  useEffect(() => {
    // FIELD ISOLATION: clear the previous field's results first.
    setWm(null); setIntel(null); setError(null);
    if (currentField) load(currentField.id);
  }, [currentField, load]);

  const runAnalysis = async () => {
    if (!currentField || busy) return;
    setBusy(true); setError(null);
    try {
      // POST analyze runs the real pipeline on stored evidence (fetches current
      // weather when missing) and persists anomalies/risks/uncertainty.
      const r = await api.post<{ success: boolean; data: any }>('/fields/' + currentField.id + '/analyze', { fetch_weather: true, fetch_satellite: false, fetch_soil: false, fetch_terrain: false });
      if (!r.success) setError('Analysis returned no result');
      await load(currentField.id);
    } catch (e: any) {
      setError(e?.message || 'Analysis failed');
    } finally { setBusy(false); }
  };

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">🧠</div>
      <h2 className="text-xl font-semibold text-slate-800 mb-2">{t('intelligence.title')}</h2>
      <p className="text-slate-500">{t('world.no_field')}</p>
    </div>
  );

  const anomalies = intel?.anomalies || wm?.anomalies || [];
  const risks = intel?.risks || wm?.risks || [];
  const contradictions = intel?.contradictions || wm?.contradictions || [];
  const uncertainty = intel?.uncertainty || wm?.uncertainty || null;
  const coverage = wm?.coverage || uncertainty?.coverage || null;
  const gaps: string[] = wm?.evidence_gaps || uncertainty?.explanation || [];
  const nextObs = intel?.next_observations || [];
  const analysisState = intel?.analysis_state || (anomalies.length || risks.length ? 'ANALYZED' : 'NOT_ANALYZED');
  const analyzed = analysisState === 'ANALYZED' || anomalies.length > 0 || risks.length > 0;

  const EmptyHint = ({ title, body }: { title: string; body: string }) => (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-8 text-center">
      <p className="text-sm font-medium text-slate-700 mb-1">{title}</p>
      <p className="text-xs text-slate-400 max-w-md mx-auto leading-relaxed">{body}</p>
    </div>
  );

  return (
    <div className="h-full flex flex-col bg-slate-100 overflow-hidden">
      <div className="px-6 pt-5 pb-3 bg-white border-b border-slate-200 shrink-0">
        <div className="flex items-end justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{t('intelligence.title')}</h1>
            <p className="text-xs text-slate-500 mt-0.5">{currentField.name} · {typeof currentField.area_hectares === 'number' && isFinite(currentField.area_hectares) ? currentField.area_hectares.toFixed(2) + ' ha' : 'AREA UNKNOWN'}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`px-2.5 py-1 rounded-full border text-[11px] font-medium ${analyzed ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
              {analyzed ? 'ANALYZED — results from persisted engine runs' : 'NOT_ANALYZED — pipeline not yet run on this field'}
            </span>
            <button onClick={runAnalysis} disabled={busy || loading}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-2">
              {busy && <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />}
              {busy ? 'Running analysis…' : '▶ Run analysis'}
            </button>
          </div>
        </div>
        <div className="flex gap-1.5 mt-3 flex-wrap">
          {tabs.map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${activeTab === tab.key ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'}`}>
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 max-w-6xl w-full">
        {loading ? (
          <div className="flex items-center justify-center py-16"><div className="w-8 h-8 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-4 text-sm text-rose-700">{error}</div>
        ) : (
          <div className="space-y-4">
            {activeTab === 'anomalies' && (
              <div>
                {anomalies.length === 0 ? (
                  <EmptyHint title={analyzed ? 'No anomalies detected' : 'Anomaly engine has not run yet'}
                    body={analyzed
                      ? 'The pipeline ran on the stored evidence and found no supported anomaly — none are fabricated.'
                      : 'Run analysis above. Detection uses only real evidence (vegetation change, weather, sensor, cross-source disagreement); with insufficient data no anomaly is generated.'} />
                ) : anomalies.map((a: any) => (
                  <div key={a.id} className="bg-white rounded-xl border border-slate-200 p-4 mb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-amber-700">🔍 {a.type}</span>
                      <span className="text-[10px] text-slate-400">{a.method || 'method recorded'}</span>
                    </div>
                    <p className="text-xs text-slate-600">{a.description || a.rationale || 'Anomaly recorded'}</p>
                    <p className="text-[10px] text-slate-400 mt-1">detected {new Date(a.detected_at || a.created_at).toLocaleString()}{a.evidence_ids?.length ? ` · ${a.evidence_ids.length} supporting evidence id(s)` : ''}</p>
                  </div>
                ))}
              </div>
            )}
            {activeTab === 'risks' && (
              <div>
                {risks.length === 0 ? (
                  <EmptyHint title={analyzed ? 'No risks scored' : 'Risk engine has not run yet'}
                    body={analyzed
                      ? 'No risk reached the rule threshold on current evidence. LOW/MEDIUM/HIGH are emitted only when the stored model/rule supports them — never invented.'
                      : 'Run analysis above to score explainable risks from evidence (type, drivers, affected area, severity).'} />
                ) : risks.map((r: any) => (
                  <div key={r.id} className="bg-white rounded-xl border border-slate-200 p-4 mb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-slate-800">⚠️ {r.type}</span>
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${sevChip(r.severity)}`}>{r.severity || 'NOT_ASSESSED'}</span>
                    </div>
                    <p className="text-xs text-slate-600">{r.description || r.rationale || 'Risk recorded'}</p>
                    <div className="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-x-3">
                      <span>uncertainty: <b className="text-slate-500">{r.uncertainty || 'NOT_ASSESSED'}</b></span>
                      {r.drivers?.length ? <span>drivers: {r.drivers.join(', ')}</span> : null}
                      {r.affected_area_ha != null ? <span>affected: {r.affected_area_ha} ha</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {activeTab === 'uncertainty' && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-slate-800 mb-3">Uncertainty — from data gaps, never a fake percentage</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <div className="text-[11px] text-slate-500">Evidence coverage label</div>
                    <div className="text-sm font-bold text-slate-800 mt-0.5">{coverage?.label || 'NOT_COMPUTED'}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <div className="text-[11px] text-slate-500">Evidence items</div>
                    <div className="text-sm font-bold text-slate-800 mt-0.5">{coverage?.total_evidence ?? '—'}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <div className="text-[11px] text-slate-500">Freshest evidence</div>
                    <div className="text-sm font-bold text-slate-800 mt-0.5">{coverage?.freshest ? new Date(coverage.freshest).toLocaleDateString() : '—'}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 border border-slate-200 p-3">
                    <div className="text-[11px] text-slate-500">Data quality</div>
                    <div className="text-sm font-bold text-slate-800 mt-0.5">{uncertainty?.data_quality || 'NOT_ASSESSED'}</div>
                  </div>
                </div>
                {coverage?.domains && (
                  <div className="flex flex-wrap gap-1.5 mb-4">
                    {Object.entries(coverage.domains).map(([d, st]) => (
                      <span key={d} className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${sevChip(String(st))}`}>{d}: {String(st)}</span>
                    ))}
                  </div>
                )}
                <h4 className="text-xs font-semibold text-slate-700 mb-2">Why are parts of this field unknown?</h4>
                {gaps.length === 0 ? (
                  <p className="text-xs text-slate-400">No open evidence gaps recorded — every domain has evidence.</p>
                ) : (
                  <ul className="space-y-1">{gaps.map((g: string, i: number) => <li key={i} className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1">{g}</li>)}</ul>
                )}
              </div>
            )}
            {activeTab === 'contradictions' && (
              <div>
                {contradictions.length === 0 ? (
                  <EmptyHint title={analyzed ? 'No contradictions detected' : 'Contradiction engine has not run yet'}
                    body={analyzed
                      ? 'No genuine cross-domain conflict (e.g. satellite vegetation decline vs sensor moisture normal) is supported by current evidence.'
                      : 'Run analysis above. Contradictions are detected only from real cross-domain disagreement — they are never fabricated.'} />
                ) : contradictions.map((c: any) => (
                  <div key={c.id} className="bg-white rounded-xl border border-rose-200 p-4 mb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-rose-700">⚡ {c.type}</span>
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${sevChip(c.severity)}`}>{c.severity || 'UNKNOWN'}</span>
                    </div>
                    <p className="text-xs text-slate-600">{c.description || c.rationale || ''}</p>
                  </div>
                ))}
              </div>
            )}
            {activeTab === 'next' && (
              <div className="bg-white rounded-xl border border-slate-200 p-5">
                <h3 className="text-sm font-semibold text-slate-800 mb-1">Next Best Observation</h3>
                <p className="text-[11px] text-slate-400 mb-4">Ranking is qualitative (HIGH/MEDIUM/LOW) with an explanation — numerical information gain is not implemented and is never faked.</p>
                {nextObs.length === 0 ? (
                  <p className="text-xs text-slate-400">No next-observation suggestions generated — suggestions are ranked from actual evidence gaps.</p>
                ) : nextObs.map((n: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 py-2.5 border-b border-slate-100 last:border-0">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium shrink-0 ${sevChip(n.priority)}`}>{n.priority || 'UNKNOWN'}</span>
                    <div>
                      <div className="text-xs font-semibold text-slate-800">{n.type || n.observation_type}</div>
                      <p className="text-[11px] text-slate-500 mt-0.5">{n.rationale || n.reason || ''}</p>
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
