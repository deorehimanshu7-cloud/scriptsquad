import React from 'react';

/** Truthful evidence-state chip colors (same palette as World/Evidence pages). */
export const STATE_COLORS: Record<string, string> = {
  OBSERVED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  DERIVED: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
  MODEL_DERIVED: 'bg-blue-500/20 text-blue-300 border-blue-500/40',
  REANALYSIS: 'bg-teal-500/20 text-teal-300 border-teal-500/40',
  PREDICTED: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
  ESTIMATED: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
  SIMULATED: 'bg-pink-500/20 text-pink-300 border-pink-500/40',
  HISTORICAL: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/40',
  AVAILABLE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  NO_DATA: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  UNKNOWN: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  UNAVAILABLE: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  AUTH_REQUIRED: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  TIMEOUT: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  RATE_LIMITED: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  PROVIDER_ERROR: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  PENDING: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  VALID: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  ONLINE: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  STALE: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  OFFLINE: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  MAINTENANCE: 'bg-orange-500/20 text-orange-300 border-orange-500/40',
  CALIBRATED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  CALIBRATION_EXPIRED: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  NOT_CALIBRATED: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
  SUSPECT: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  VALIDATED: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  REJECTED: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  DUPLICATE: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

export function StateChip({ state }: { state?: string | null }) {
  const s = state || 'UNKNOWN';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-semibold uppercase tracking-wide ${STATE_COLORS[s] || STATE_COLORS.UNKNOWN}`}>
      {s.replace(/_/g, ' ')}
    </span>
  );
}

export function Panel({ title, right, children, className = '' }: { title?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-slate-800/60 border border-slate-700 rounded-xl overflow-hidden ${className}`}>
      {(title || right) && (
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/70">
          <div className="text-sm font-semibold text-slate-200">{title}</div>
          <div>{right}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}

export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="border border-dashed border-slate-600 rounded-lg px-4 py-6 text-center bg-slate-900/40">
      <p className="text-sm font-semibold text-slate-300">{title}</p>
      {message && <p className="text-xs text-slate-400 mt-1 whitespace-pre-line">{message}</p>}
    </div>
  );
}

export function ErrorState({ title, message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div className="border border-rose-500/40 bg-rose-500/10 rounded-lg px-4 py-4">
      <p className="text-sm font-semibold text-rose-300">{title || 'Request failed'}</p>
      {message && <p className="text-xs text-rose-200/80 mt-1 whitespace-pre-line">{message}</p>}
      {onRetry && (
        <button onClick={onRetry} className="mt-2 text-xs px-2.5 py-1 rounded bg-rose-500/20 text-rose-200 hover:bg-rose-500/30 border border-rose-500/30">
          Retry
        </button>
      )}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
      <span className="inline-block w-4 h-4 border-2 border-slate-500 border-t-emerald-400 rounded-full animate-spin" />
      {label}
    </div>
  );
}

export function Value({ v, suffix = '', fallback = 'Unavailable' }: { v: unknown; suffix?: string; fallback?: string }) {
  if (v === null || v === undefined || v === '') return <span className="text-slate-500 italic">{fallback}</span>;
  return <span>{String(v)}{suffix}</span>;
}

/** Generic minimal table for heterogeneous API rows (defensive). */
export function GenericTable({ rows, emptyTitle, emptyMessage }: { rows: Record<string, unknown>[]; emptyTitle?: string; emptyMessage?: string }) {
  if (!rows.length) {
    return <EmptyState title={emptyTitle || 'No data'} message={emptyMessage || 'Nothing is stored for this query yet.'} />;
  }
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 9);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-slate-400 uppercase tracking-wide">
            {cols.map((c) => <th key={c} className="px-2 py-1.5 font-semibold whitespace-nowrap">{c.replace(/_/g, ' ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 100).map((r, i) => (
            <tr key={i} className="border-b border-slate-800 hover:bg-slate-800/40">
              {cols.map((c) => {
                const v = r[c];
                let cell: React.ReactNode = v === null || v === undefined ? <span className="text-slate-600">—</span> : String(v);
                if (typeof v === 'object') cell = <span className="text-slate-400">{(v as any).name || JSON.stringify(v).slice(0, 40)}</span>;
                if (typeof v === 'string' && v.length > 48) cell = `${v.slice(0, 45)}…`;
                return <td key={c} className="px-2 py-1.5 text-slate-300 align-top max-w-[260px] break-words">{cell}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InfoNote({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-slate-400 leading-relaxed">{children}</p>;
}
