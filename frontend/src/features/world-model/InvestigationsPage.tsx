import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

export default function InvestigationsPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [investigations, setInvestigations] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // FIELD ISOLATION: clear the previous field's investigations first.
    setInvestigations([]);
    if (currentField) fetchInvestigations();
  }, [currentField]);

  const fetchInvestigations = async () => {
    if (!currentField) return;
    setLoading(true);
    try {
      const r = await api.get<{ success: boolean; data: any }>('/fields/' + currentField.id + '/investigations');
      if (r.success) setInvestigations(r.data || []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">🔍</div>
      <h2 className="text-xl font-semibold text-slate-200 mb-2">{t('investigation.title')}</h2>
      <p className="text-slate-400">{t('world.no_field')}</p>
    </div>
  );

  const workflowSteps = ['Trigger', 'Problem', 'Evidence', 'Hypothesis', 'Next Obs', 'Conclusion', 'Action', 'Verify'];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-200">{t('investigation.title')}</h1>
        <p className="text-slate-400 mt-1">{currentField.name}</p>
      </div>

      <div className="bg-slate-800 rounded-xl p-6 border border-slate-700 mb-6">
        <h3 className="text-lg font-semibold text-slate-200 mb-4">Investigation Workflow</h3>
        <div className="flex items-center justify-between gap-2 overflow-x-auto pb-2">
          {workflowSteps.map((step, i) => (
            <React.Fragment key={step}>
              <div className="flex flex-col items-center gap-2 min-w-[80px]">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold ${i === 0 ? 'bg-purple-500/20 text-purple-400 border border-purple-500/50' : 'bg-slate-700 text-slate-400 border border-slate-600'}`}>
                  {i + 1}
                </div>
                <span className="text-xs text-slate-400 text-center">{step}</span>
              </div>
              {i < 7 && <div className="w-8 h-0.5 bg-slate-600 mt-[-16px]" />}
            </React.Fragment>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : investigations.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 border border-slate-700 text-center">
          <div className="text-5xl mb-4">🔍</div>
          <h3 className="text-lg font-semibold text-slate-200 mb-2">{t('investigation.no_investigations')}</h3>
          <p className="text-slate-400 text-sm max-w-md mx-auto">
            Investigations are triggered automatically when contradictions or anomalies are detected.
            You can also create one manually from the Intelligence or Evidence pages.
          </p>
          <button className="mt-6 px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors">
            + {t('investigation.create')}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {investigations.map((inv: any) => (
            <div key={inv.id} className="bg-slate-800 rounded-xl p-6 border border-slate-700 hover:border-purple-500/50 transition-colors cursor-pointer">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h4 className="text-lg font-semibold text-slate-200">{inv.title || 'Investigation'}</h4>
                  <p className="text-sm text-slate-400 mt-1">{inv.description || 'No description'}</p>
                </div>
                <span className="px-3 py-1 text-xs font-medium rounded-full bg-yellow-500/20 text-yellow-400">{inv.status}</span>
              </div>
              {inv.hypotheses && inv.hypotheses.length > 0 && (
                <div className="mt-4">
                  <h5 className="text-sm font-medium text-slate-300 mb-2">Hypotheses</h5>
                  {inv.hypotheses.map((h: any, i: number) => (
                    <div key={i} className="bg-slate-700/50 rounded-lg p-3 text-sm text-slate-300 mb-2">
                      💡 {h.description || h}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
