import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';

export default function HistoryPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // FIELD ISOLATION: clear the previous field's history first.
    setHistory([]);
    if (currentField) fetchHistory();
  }, [currentField]);

  const fetchHistory = async () => {
    if (!currentField) return;
    setLoading(true);
    try {
      const r = await api.get<{ success: boolean; data: any }>('/fields/' + currentField.id + '/world-model/history');
      if (r.success) setHistory(r.data || []);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">📈</div>
      <h2 className="text-xl font-semibold text-slate-200 mb-2">Farm History</h2>
      <p className="text-slate-400">{t('world.no_field')}</p>
    </div>
  );

  const cats = [
    { icon: '🛰️', label: 'Satellite', color: 'text-purple-400' },
    { icon: '🌤️', label: 'Weather', color: 'text-yellow-400' },
    { icon: '📡', label: 'Sensor', color: 'text-cyan-400' },
    { icon: '🌾', label: 'Crop', color: 'text-green-400' },
    { icon: '🔍', label: 'Anomaly', color: 'text-orange-400' },
    { icon: '⚠️', label: 'Risk', color: 'text-red-400' },
    { icon: '✅', label: 'Action', color: 'text-blue-400' },
  ];

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-200">Farm History &mdash; Farm Memory</h1>
        <p className="text-slate-400 mt-1">{currentField.name}</p>
      </div>
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {cats.map(c => (
          <div key={c.label} className={`flex items-center gap-2 px-3 py-1.5 bg-slate-800 rounded-lg border border-slate-700 text-sm ${c.color}`}>
            <span>{c.icon}</span><span>{c.label}</span>
          </div>
        ))}
      </div>
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : history.length === 0 ? (
        <div className="bg-slate-800 rounded-xl p-12 border border-slate-700 text-center">
          <div className="text-5xl mb-4">📈</div>
          <h3 className="text-lg font-semibold text-slate-200 mb-2">No history yet</h3>
          <p className="text-slate-400 text-sm max-w-md mx-auto">
            Farm history accumulates as satellite observations, weather data, sensor readings, and actions are recorded over time.
          </p>
        </div>
      ) : (
        <div className="relative">
          <div className="absolute left-4 top-0 bottom-0 w-0.5 bg-slate-700" />
          <div className="space-y-6 pl-12">
            {history.map((event: any, i: number) => (
              <div key={i} className="relative">
                <div className="absolute -left-12 w-8 h-8 bg-slate-800 border border-slate-600 rounded-full flex items-center justify-center text-sm">{event.icon || '📌'}</div>
                <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-slate-200">{event.title || 'Event'}</span>
                    <span className="text-xs text-slate-500">{new Date(event.timestamp || event.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-sm text-slate-400">{event.description || ''}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
