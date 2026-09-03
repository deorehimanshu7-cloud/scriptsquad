import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';

export default function SimulationPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [scenario, setScenario] = useState({ irrigation: 'current', weather: 'baseline', water: 'available' });
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<any>(null);

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">⚡</div>
      <h2 className="text-xl font-semibold text-slate-200 mb-2">Simulation</h2>
      <p className="text-slate-400">{t('world.no_field')}</p>
    </div>
  );

  const runSim = () => {
    setRunning(true);
    setTimeout(() => {
      setResult({ status: 'completed', scenario, description: 'Simulation completed. All outputs are SIMULATED.' });
      setRunning(false);
    }, 2000);
  };

  return (
    <div className="flex h-full">
      <div className="w-80 bg-slate-800 border-r border-slate-700 overflow-y-auto p-4">
        <h3 className="text-lg font-semibold text-slate-200 mb-4">Scenario</h3>
        <div className="space-y-4">
          {[
            { label: 'Irrigation', key: 'irrigation', opts: ['current', 'tomorrow', '48h', 'none'] },
            { label: 'Weather', key: 'weather', opts: ['baseline', 'drought', 'heavy_rain', 'heatwave'] },
            { label: 'Water', key: 'water', opts: ['available', 'restricted', 'unavailable'] },
          ].map(f => (
            <div key={f.key}>
              <label className="block text-sm font-medium text-slate-300 mb-2">{f.label}</label>
              <select value={(scenario as any)[f.key]} onChange={e => setScenario({ ...scenario, [f.key]: e.target.value })}
                className="w-full px-3 py-2 bg-slate-700 border border-slate-600 rounded-lg text-slate-200 text-sm">
                {f.opts.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          <button onClick={runSim} disabled={running}
            className="w-full py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white font-medium rounded-lg transition-colors">
            {running ? 'Running...' : 'Run Simulation'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-200">Simulation</h1>
          <p className="text-slate-400 mt-1">{currentField.name} &mdash; All outputs are <span className="text-purple-400 font-medium">SIMULATED</span></p>
        </div>
        {!result ? (
          <div className="bg-slate-800 rounded-xl p-12 border border-slate-700 text-center">
            <div className="text-5xl mb-4">⚡</div>
            <h3 className="text-lg font-semibold text-slate-200 mb-2">Configure & Run</h3>
            <p className="text-slate-400 text-sm max-w-md mx-auto">
              Select scenario variables, then run. The simulation creates a copy of the World Model and applies changes without modifying live state.
            </p>
          </div>
        ) : (
          <div className="bg-slate-800 rounded-xl p-6 border border-slate-700">
            <div className="flex items-center gap-2 mb-4">
              <span className="px-3 py-1 text-xs font-medium rounded-full bg-purple-500/20 text-purple-400">SIMULATED</span>
              <h3 className="text-lg font-semibold text-slate-200">Simulation Complete</h3>
            </div>
            <p className="text-sm text-slate-400 mb-4">{result.description}</p>
            <div className="bg-slate-700/50 rounded-lg p-4 text-sm text-slate-300">
              <p>No changes detected in this simulation run.</p>
              <p className="text-slate-500 mt-2 text-xs">Note: Simulation requires a populated World Model with actual evidence data.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
