import type { CSSProperties, ReactNode } from "react";
import type { ProviderState, TruthState } from "../lib/types";
import { TRUTH_LABELS } from "../lib/types";

export function Badge({ className = "", children, title, style }: { className?: string; children: ReactNode; title?: string; style?: CSSProperties }) {
  return (
    <span className={`badge ${className}`} title={title} style={style}>
      {children}
    </span>
  );
}

export function TruthBadge({ state, lg }: { state: TruthState; lg?: boolean }) {
  return (
    <Badge className={`ts-${state} ${lg ? "badge-lg" : ""}`} title={`Truth state: ${TRUTH_LABELS[state] ?? state}`}>
      {state}
    </Badge>
  );
}

export function ProviderBadge({ state }: { state: ProviderState | string }) {
  return <Badge className={`ps-${state}`}>{state}</Badge>;
}

export function RiskBadge({ level }: { level: string }) {
  return <Badge className={`rl-${level}`}>{level}</Badge>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <Badge className={`sev-${severity}`}>{severity}</Badge>;
}

export function Card({ title, dot = true, children, className = "", right, style }: { title?: string; dot?: boolean; children: ReactNode; className?: string; right?: ReactNode; style?: CSSProperties }) {
  return (
    <div className={`card ${className}`} style={style}>
      {title && (
        <div className="card-title">
          {dot && <span className="dot" />}
          <span className="grow">{title}</span>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </div>
  );
}

export function EmptyState({ emoji = "🌱", title, body, action }: { emoji?: string; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="emoji">{emoji}</div>
      <h4>{title}</h4>
      {body && <div className="muted" style={{ fontSize: 13 }}>{body}</div>}
      {action && <div className="mt-16 row" style={{ justifyContent: "center" }}>{action}</div>}
    </div>
  );
}

export function Stat({ label, value, unit, hint }: { label: string; value: ReactNode; unit?: string; hint?: string }) {
  return (
    <div>
      <div className="section-label">{label}</div>
      <div className="val-lg">
        {value}
        {unit && <span className="val-unit">{unit}</span>}
      </div>
      {hint && <div className="faint" style={{ fontSize: 12, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

export function KV({ pairs }: { pairs: [string, ReactNode][] }) {
  return (
    <dl className="kv">
      {pairs.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Hint({ children, warn, className = "" }: { children: ReactNode; warn?: boolean; className?: string }) {
  return <div className={`hint ${warn ? "hint-warn" : ""} ${className}`}>{children}</div>;
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string; count?: number }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab ${active === t.id ? "active" : ""}`} onClick={() => onChange(t.id)} type="button">
          {t.label}
          {t.count !== undefined && <span className="faint"> · {t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function FieldValue({ value, unit }: { value: number | null | undefined; unit?: string | null }) {
  if (value === null || value === undefined) return <span className="faint">—</span>;
  return (
    <span className="mono-val">
      {value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      {unit ? <span className="val-unit">{unit}</span> : null}
    </span>
  );
}