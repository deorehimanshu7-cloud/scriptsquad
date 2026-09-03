import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api/client';

interface Provider { id: string; name: string; type: string; status: string; description: string; last_check: string; }
interface ProviderHealth { provider: string; status: string; latency_ms: number | null; success_rate_measured: number | null; requests_measured: number; last_error: string | null; }

export default function SystemProvidersPage() {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [health, setHealth] = useState<ProviderHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { fetchData(); }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [p, h] = await Promise.all([
        api.get<{ success: boolean; data: Provider[] }>('/system/providers'),
        api.get<{ success: boolean; data: ProviderHealth[] }>('/system/providers/health'),
      ]);
      if (p.success) setProviders(p.data);
      if (h.success) setHealth(h.data);
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const sc = (s: string) => s === 'AVAILABLE' ? 'bg-green-500/20 text-green-400' : s === 'AUTH_REQUIRED' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-red-500/20 text-red-400';
  const sd = (s: string) => s === 'AVAILABLE' ? 'bg-green-500' : s === 'AUTH_REQUIRED' ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mb-6"><h1 className="text-2xl font-bold text-slate-200">System — Provider Health</h1>
        <p className="text-slate-400 mt-1">Monitor external data providers</p></div>
      {loading ? (
        <div className="flex items-center justify-center py-12"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>
      ) : (
        <div className="space-y-4">
          {providers.map(provider => {
            const ph = health.find(h => h.provider === provider.id);
            return (
              <div key={provider.id} className="bg-slate-800 rounded-xl p-6 border border-slate-700">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${sd(provider.status)}`} />
                    <div><h3 className="text-lg font-semibold text-slate-200">{provider.name}</h3>
                      <p className="text-sm text-slate-400">{provider.description}</p></div>
                  </div>
                  <span className={`px-3 py-1 text-xs font-medium rounded-full ${sc(provider.status)}`}>{provider.status.replace(/_/g, ' ')}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div className="bg-slate-700/50 rounded-lg p-3"><div className="text-xs text-slate-400 mb-1">Type</div><div className="text-sm font-medium text-slate-200 capitalize">{provider.type}</div></div>
                  <div className="bg-slate-700/50 rounded-lg p-3"><div className="text-xs text-slate-400 mb-1">Latency</div><div className="text-sm font-medium text-slate-200">{typeof ph?.latency_ms === 'number' ? ph.latency_ms + 'ms' : '—'}</div></div>
                  <div className="bg-slate-700/50 rounded-lg p-3"><div className="text-xs text-slate-400 mb-1">Measured Success Rate</div><div className="text-sm font-medium text-slate-200">{typeof ph?.success_rate_measured === 'number' ? (ph.success_rate_measured * 100).toFixed(1) + '%' : 'NOT MEASURED'}</div></div>
                  <div className="bg-slate-700/50 rounded-lg p-3"><div className="text-xs text-slate-400 mb-1">Last Check</div><div className="text-sm font-medium text-slate-200">{new Date(provider.last_check).toLocaleTimeString()}</div></div>
                </div>
                {ph?.last_error && <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg p-3"><p className="text-xs text-red-400">Last Error: {ph.last_error}</p></div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
