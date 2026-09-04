import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../lib/state";
import { intelApi, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, Spinner, Tabs, TruthBadge } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, timeAgo } from "../../lib/format";
import type { Domain, EvidenceRecord, EvidenceRelationship, TruthState } from "../../lib/types";
import { DOMAIN_LABELS, TRUTH_LABELS } from "../../lib/types";

const DOMAINS: (Domain | "all")[] = ["all", "sensor", "satellite", "weather", "water", "soil", "terrain", "crop", "farmer", "simulation"];
const STATES: (TruthState | "ALL")[] = ["ALL", "OBSERVED", "DERIVED", "ESTIMATED", "HISTORICAL", "PREDICTED", "SIMULATED", "UNKNOWN"];

export default function Evidence() {
  return (
    <RequireField>
      <EvidenceInner />
    </RequireField>
  );
}

function EvidenceInner() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const [evidence, setEvidence] = useState<EvidenceRecord[] | null>(null);
  const [domain, setDomain] = useState<Domain | "all">("all");
  const [stateFilter, setStateFilter] = useState<TruthState | "ALL">("ALL");
  const [openId, setOpenId] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<EvidenceRelationship[]>([]);

  useEffect(() => {
    let cancelled = false;
    setEvidence(null);
    void worldApi
      .evidence(field.id, { limit: 400 })
      .then((res) => {
        if (!cancelled) setEvidence(res.evidence);
      })
      .catch(() => {
        if (!cancelled) setEvidence([]);
      });
    void intelApi
      .relationships(field.id)
      .then((r) => {
        if (!cancelled) setRelationships(r.relationships);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [field.id, refreshToken]);

  const filtered = useMemo(() => {
    if (!evidence) return null;
    return evidence.filter((e) => (domain === "all" || e.domain === domain) && (stateFilter === "ALL" || e.state === stateFilter));
  }, [evidence, domain, stateFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: evidence?.length ?? 0 };
    for (const e of evidence ?? []) c[e.domain] = (c[e.domain] ?? 0) + 1;
    return c;
  }, [evidence]);

  if (!evidence) return <div className="page"><Spinner label="Loading evidence…" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Evidence — {field.name}</div>
          <div className="page-sub">
            Every record carries an explicit truth state and full provenance. Model output is never presented as sensor
            observation; unavailable sources are labelled, not filled.
          </div>
        </div>
      </div>

      <Tabs
        active={domain}
        onChange={(d) => setDomain(d as Domain | "all")}
        tabs={DOMAINS.map((d) => ({ id: d, label: d === "all" ? "All domains" : DOMAIN_LABELS[d], count: counts[d] ?? 0 }))}
      />

      <div className="row mb-16" style={{ gap: 6 }}>
        {STATES.map((s) => (
          <button
            key={s}
            className={`btn btn-sm ${stateFilter === s ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setStateFilter(s)}
            type="button"
          >
            {s === "ALL" ? "All states" : TRUTH_LABELS[s]}
          </button>
        ))}
      </div>

      {filtered && filtered.length === 0 ? (
        <EmptyState
          emoji="🧬"
          title="No evidence in this view"
          body={evidence.length === 0 ? "The field has no evidence records yet. Run analysis or wait for the scheduled provider refresh." : "Try a different domain or truth state."}
        />
      ) : (
        <Card>
          <table className="tbl">
            <thead>
              <tr>
                <th>Domain</th>
                <th>Measurement</th>
                <th>Value</th>
                <th>State</th>
                <th>Observed</th>
                <th>Source</th>
                <th>Quality</th>
              </tr>
            </thead>
            <tbody>
              {filtered?.map((e) => (
                <EvidenceRow key={e.id} e={e} open={openId === e.id} onToggle={() => setOpenId(openId === e.id ? null : e.id)} />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {relationships.length > 0 && (
        <Card title={`Evidence relationships — ${relationships.length}`} className="mt-12">
          <div className="col" style={{ gap: 10 }}>
            {relationships.map((rel) => (
              <div key={rel.id} style={{ padding: "10px 0", borderBottom: "1px solid rgba(141,199,161,0.07)" }}>
                <div className="spread">
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <Badge className="dom-all">{rel.a_domain ?? "?"}</Badge>
                    <span className="mono" style={{ fontSize: 12 }}>{rel.a_sub ?? rel.evidence_a.slice(0, 14)}</span>
                    <strong style={{ color: "#e0a45e", fontSize: 12 }}>⟷ {rel.relationship} ⟷</strong>
                    <span className="mono" style={{ fontSize: 12 }}>{rel.b_sub ?? rel.evidence_b.slice(0, 14)}</span>
                    <Badge className="dom-all">{rel.b_domain ?? "?"}</Badge>
                  </div>
                  <span className="faint" style={{ fontSize: 11.5 }}>{fmtDate(rel.created_at)}</span>
                </div>
                {rel.reason && <div className="muted" style={{ fontSize: 12.5, marginTop: 5 }}>{rel.reason}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function EvidenceRow({ e, open, onToggle }: { e: EvidenceRecord; open: boolean; onToggle: () => void }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer" }}>
        <td>
          <Badge className={`dom-${e.domain}`} title={DOMAIN_LABELS[e.domain]}>{e.domain}</Badge>
        </td>
        <td>
          <div style={{ fontWeight: 600 }}>{e.measurement ?? e.sub_type}</div>
          <div className="faint mono" style={{ fontSize: 11 }}>{e.sub_type}</div>
        </td>
        <td className="mono-val nowrap">
          {e.value !== null ? (
            <>
              {e.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              {e.unit && <span className="val-unit">{e.unit}</span>}
            </>
          ) : (
            <span className="faint">text / n/a</span>
          )}
        </td>
        <td><TruthBadge state={e.state} /></td>
        <td className="nowrap" style={{ fontSize: 12.5 }}>
          <div>{fmtDate(e.observed_at)}</div>
          <div className="faint" style={{ fontSize: 11 }}>retrieved {timeAgo(e.retrieved_at)}</div>
        </td>
        <td style={{ fontSize: 12.5 }}>{e.source}</td>
        <td>
          {e.quality ? <Badge className={`sev-${e.quality === "high" ? "low" : e.quality}`}>{e.quality}</Badge> : <span className="faint">—</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} style={{ background: "rgba(141,199,161,0.03)" }}>
            <div className="grid grid-2" style={{ gap: 14 }}>
              <div>
                <div className="section-label">Provenance</div>
                <dl className="kv" style={{ gridTemplateColumns: "110px 1fr" }}>
                  <dt>provider</dt><dd className="mono">{e.provenance.provider}</dd>
                  {e.provenance.model && <><dt>model</dt><dd>{e.provenance.model}</dd></>}
                  {e.provenance.processing && <><dt>processing</dt><dd className="mono" style={{ fontSize: 12 }}>{e.provenance.processing}</dd></>}
                  {e.provenance.access_url && <><dt>source</dt><dd className="mono" style={{ fontSize: 12 }}>{e.provenance.access_url}</dd></>}
                  {e.provenance.note && <><dt>note</dt><dd>{e.provenance.note}</dd></>}
                </dl>
              </div>
              <div>
                <div className="section-label">Description</div>
                <p style={{ margin: "0 0 8px", fontSize: 13 }}>{e.description ?? "—"}</p>
                {e.quality_reason && <div className="hint">{e.quality_reason}</div>}
                <div className="prov-line mt-8">evidence_id: {e.id}</div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}