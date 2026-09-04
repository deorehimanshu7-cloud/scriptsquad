import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useApp } from "../../lib/state";
import { intelApi, toast, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, RiskBadge, SeverityBadge, Spinner, Tabs, TruthBadge } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, timeAgo } from "../../lib/format";
import type { ActionRecord, AnomalyRecord, ContradictionRecord, EvidenceRecord, Investigation, RiskRecord, UncertaintyRecord, VerificationRecord } from "../../lib/types";

type Tab = "overview" | "anomalies" | "risks" | "uncertainties" | "contradictions" | "actions" | "investigations";

export default function Intel() {
  return (
    <RequireField>
      <IntelInner />
    </RequireField>
  );
}

function IntelInner() {
  const { activeField, refreshToken, refresh } = useApp();
  const field = activeField!;
  const [tab, setTab] = useState<Tab>("overview");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [anomalies, setAnomalies] = useState<AnomalyRecord[]>([]);
  const [risks, setRisks] = useState<RiskRecord[]>([]);
  const [uncertainties, setUncertainties] = useState<UncertaintyRecord[]>([]);
  const [contradictions, setContradictions] = useState<ContradictionRecord[]>([]);
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [verifications, setVerifications] = useState<VerificationRecord[]>([]);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);

  const load = () => {
    setLoading(true);
    void intelApi
      .intelligence(field.id)
      .then((r) => {
        setAnomalies(r.anomalies);
        setRisks(r.risks);
        setUncertainties(r.uncertainties);
        setContradictions(r.contradictions);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
    void intelApi.listInvestigations(field.id).then((r) => setInvestigations(r.investigations)).catch(() => undefined);
    void intelApi.actions(field.id).then((r) => setActions(r.actions)).catch(() => undefined);
    void intelApi.verifications(field.id).then((r) => setVerifications(r.verifications)).catch(() => undefined);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.id, refreshToken]);

  const analyze = async () => {
    setRunning(true);
    try {
      const res = await worldApi.analyze(field.id);
      toast(`Analyzed: ${res.report.risks} risks, ${res.report.anomalies} anomalies, ${res.report.uncertainties} uncertainties, ${res.report.actions} actions`);
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setRunning(false);
    }
  };

  const autoInv = async () => {
    try {
      const res = await intelApi.autoInvestigate(field.id);
      setInvestigations((prev) => [res.investigation, ...prev]);
      setTab("investigations");
      toast("Investigation opened from the most severe signal");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Intelligence — {field.name}</div>
          <div className="page-sub">
            The engines reason only over recorded evidence. Levels are qualitative; reasons cite the actual evidence. No
            fabricated confidence percentages.
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={autoInv}>🔍 Auto-investigate</button>
          <button className="btn btn-primary" onClick={analyze} disabled={running}>
            {running ? <span className="spinner" /> : "⚡"} Run engines
          </button>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(t) => setTab(t as Tab)}
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "anomalies", label: "Anomalies", count: anomalies.length },
          { id: "risks", label: "Risks", count: risks.length },
          { id: "uncertainties", label: "Uncertainty", count: uncertainties.length },
          { id: "contradictions", label: "Contradictions", count: contradictions.length },
          { id: "actions", label: "Actions", count: actions.length },
          { id: "investigations", label: "Investigations", count: investigations.length },
        ]}
      />

      {loading ? (
        <Spinner label="Running intelligence views…" />
      ) : tab === "overview" ? (
        <div className="grid grid-2">
          <ListCard title="Risks" empty="No risk items evaluated." count={risks.length}>
            {risks.map((r) => (
              <SignalRow key={r.id} icon={riskIcon(r.risk_type)} title={r.risk_type.replace(/_/g, " ")} right={<RiskBadge level={r.level} />}>
                <div className="muted" style={{ fontSize: 12.5 }}>{r.reason}</div>
                <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>{fmtDate(r.created_at)} · {r.status}</div>
              </SignalRow>
            ))}
          </ListCard>
          <ListCard title="Anomalies" empty="No anomalies detected from current evidence." count={anomalies.length}>
            {anomalies.map((a) => (
              <SignalRow key={a.id} icon={anomIcon(a.kind)} title={a.kind.replace(/_/g, " ")} right={<SeverityBadge severity={a.severity} />}>
                <div className="muted" style={{ fontSize: 12.5 }}>{a.description}</div>
                <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>trigger: {a.trigger}</div>
              </SignalRow>
            ))}
          </ListCard>
          <ListCard title="Uncertainty drivers" empty="No significant uncertainty drivers found." count={uncertainties.length}>
            {uncertainties.map((u) => (
              <SignalRow key={u.id} icon="❓" title={`${u.kind.replace(/_/g, " ")}${u.domain ? ` · ${u.domain}` : ""}`} right={<RiskBadge level={u.level} />}>
                <div className="muted" style={{ fontSize: 12.5 }}>{u.reason}</div>
              </SignalRow>
            ))}
          </ListCard>
          <ListCard title="Contradictions" empty="No contradictions found between recorded evidence." count={contradictions.length}>
            {contradictions.map((c) => (
              <SignalRow key={c.id} icon="⚖️" title={c.relationship.toLowerCase()} right={<Badge className={`sev-${c.status === "open" ? "medium" : "low"}`}>{c.status}</Badge>}>
                <div className="muted" style={{ fontSize: 12.5 }}>{c.reason}</div>
              </SignalRow>
            ))}
          </ListCard>
        </div>
      ) : tab === "anomalies" ? (
        <AnomalyList anomalies={anomalies} />
      ) : tab === "risks" ? (
        <RiskList risks={risks} />
      ) : tab === "uncertainties" ? (
        <UncertaintyList uncertainties={uncertainties} />
      ) : tab === "contradictions" ? (
        <ContradictionList contradictions={contradictions} />
      ) : tab === "actions" ? (
        <ActionList fieldId={field.id} actions={actions} verifications={verifications} reload={load} />
      ) : (
        <Investigations fieldId={field.id} investigations={investigations} setInvestigations={setInvestigations} />
      )}
    </div>
  );
}

function riskIcon(t: string): string {
  return { heat_stress: "🌡️", water_stress: "💧", flood: "🌊", sensor_reliability: "📡", disease_pest: "🐛", nutrient: "🧪" }[t] ?? "⚠️";
}
function anomIcon(k: string): string {
  return { sensor_spike: "📈", heavy_rainfall: "🌧️", vegetation_change: "🌿", moisture_drop: "💧" }[k] ?? "⚠️";
}

function ListCard({ title, empty, count, children }: { title: string; empty: string; count: number; children: ReactNode }) {
  return (
    <Card title={title} right={<span className="badge">{count}</span>}>
      {count === 0 ? <div className="muted" style={{ fontSize: 13 }}>{empty}</div> : <div className="col" style={{ gap: 0 }}>{children}</div>}
    </Card>
  );
}

function SignalRow({ icon, title, right, children }: { icon: string; title: string; right: ReactNode; children: ReactNode }) {
  return (
    <div style={{ padding: "10px 0", borderBottom: "1px solid rgba(141,199,161,0.07)" }}>
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <span>{icon}</span>
          <strong style={{ textTransform: "capitalize" }}>{title}</strong>
        </div>
        {right}
      </div>
      <div style={{ marginTop: 5 }}>{children}</div>
    </div>
  );
}

function AnomalyList({ anomalies }: { anomalies: AnomalyRecord[] }) {
  if (!anomalies.length) return <EmptyState emoji="📈" title="No anomalies" body="The anomaly engine found nothing outside expected ranges in the recorded evidence." />;
  return (
    <div className="col" style={{ gap: 10 }}>
      {anomalies.map((a) => (
        <Card key={a.id}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <strong style={{ textTransform: "capitalize" }}>{a.kind.replace(/_/g, " ")}</strong>
              <SeverityBadge severity={a.severity} />
              <Badge className="ps-NO_DATA">{a.status}</Badge>
            </div>
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(a.detected_at)}</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 4px", fontSize: 13.5 }}>{a.description}</p>
          <div className="prov-line">trigger: {a.trigger}</div>
        </Card>
      ))}
    </div>
  );
}

function RiskList({ risks }: { risks: RiskRecord[] }) {
  if (!risks.length) return <EmptyState emoji="🛡️" title="No risks evaluated" body="Not enough evidence yet for the risk engines." />;
  return (
    <div className="col" style={{ gap: 10 }}>
      {risks.map((r) => (
        <Card key={r.id}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <strong style={{ textTransform: "capitalize" }}>{r.risk_type.replace(/_/g, " ")}</strong>
              <RiskBadge level={r.level} />
            </div>
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(r.created_at)}</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13.5 }}>{r.reason}</p>
        </Card>
      ))}
    </div>
  );
}

function UncertaintyList({ uncertainties }: { uncertainties: UncertaintyRecord[] }) {
  if (!uncertainties.length) return <EmptyState emoji="❓" title="No uncertainty drivers" body="No significant data gaps or staleness found." />;
  return (
    <div className="col" style={{ gap: 10 }}>
      {uncertainties.map((u) => (
        <Card key={u.id}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <strong style={{ textTransform: "capitalize" }}>{u.kind.replace(/_/g, " ")}{u.domain ? ` · ${u.domain}` : ""}</strong>
              <RiskBadge level={u.level} />
            </div>
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(u.created_at)}</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13.5 }}>{u.reason}</p>
        </Card>
      ))}
    </div>
  );
}

const ACTION_STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  recommended: { bg: "rgba(240,173,78,0.14)", color: "#f0ad4e" },
  taken: { bg: "rgba(94,164,255,0.14)", color: "#5ea4ff" },
  verified: { bg: "rgba(63,217,124,0.14)", color: "#3fd97c" },
  dismissed: { bg: "rgba(150,160,150,0.14)", color: "#96a096" },
};

function StatusChip({ status }: { status: string }) {
  const s = ACTION_STATUS_STYLE[status] ?? ACTION_STATUS_STYLE.dismissed;
  return (
    <span
      style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, padding: "3px 8px", borderRadius: 6, background: s.bg, color: s.color }}
    >
      {status}
    </span>
  );
}

function ActionList({
  fieldId,
  actions,
  verifications,
  reload,
}: {
  fieldId: string;
  actions: ActionRecord[];
  verifications: VerificationRecord[];
  reload: () => void;
}) {
  const [outcomeDraft, setOutcomeDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const setStatus = async (a: ActionRecord, status: "taken" | "verified" | "dismissed") => {
    setBusy(a.id);
    try {
      await intelApi.setActionStatus(fieldId, a.id, {
        status,
        outcome: status === "verified" ? (outcomeDraft[a.id]?.trim() || null) : null,
      });
      toast(status === "verified" ? "Verification recorded in farm memory" : `Action marked ${status}`);
      setOutcomeDraft((d) => ({ ...d, [a.id]: "" }));
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(null);
    }
  };

  if (!actions.length) {
    return (
      <EmptyState
        emoji="🧭"
        title="No recommended actions"
        body="Recommendations are generated only from MEDIUM/HIGH risks and are evidence-linked. UNKNOWN/LOW risks produce no action — we never recommend acting on insufficient evidence."
      />
    );
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Decision layer: recommended actions are created from MEDIUM/HIGH risks only and cite the risk evidence. Marking taken / verified
        records a farm-memory entry; verification stores a dated outcome (state OBSERVED).
      </p>
      {actions.map((a) => (
        <Card key={a.id}>
          <div className="spread">
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <strong>{a.title}</strong>
              <StatusChip status={a.status} />
              <span className="badge">{a.kind}</span>
              {a.risk_level && <RiskBadge level={a.risk_level} />}
            </div>
            <span className="faint" style={{ fontSize: 12 }}>{fmtDate(a.created_at)}</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 4px", fontSize: 13.5 }}>{a.description}</p>
          <div className="prov-line" style={{ fontSize: 11.5 }}>
            {a.risk_type ? `linked risk: ${a.risk_type.replace(/_/g, " ")}` : "manual action"}
            {a.evidence_ids && a.evidence_ids !== "[]" ? ` · evidence: ${JSON.parse(a.evidence_ids).length} record(s)` : ""}
          </div>
          {a.status === "recommended" || a.status === "taken" ? (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {a.status === "recommended" && (
                <button className="btn" disabled={busy === a.id} onClick={() => void setStatus(a, "taken")}>
                  ✅ Mark taken
                </button>
              )}
              <input
                className="input"
                style={{ flex: 1, minWidth: 180, padding: "6px 10px" }}
                placeholder="Outcome (optional) — e.g. irrigated 2 h on Sep 5"
                value={outcomeDraft[a.id] ?? ""}
                onChange={(e) => setOutcomeDraft((d) => ({ ...d, [a.id]: e.target.value }))}
              />
              <button className="btn btn-primary" disabled={busy === a.id} onClick={() => void setStatus(a, "verified")}>
                ✔ Verify outcome
              </button>
              <button className="btn" disabled={busy === a.id} onClick={() => void setStatus(a, "dismissed")}>
                ✕ Dismiss
              </button>
            </div>
          ) : (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
              {a.status === "verified" ? "Verified — outcome stored with a dated record." : "Dismissed by the farmer."}
            </div>
          )}
        </Card>
      ))}
      {verifications.length > 0 && (
        <Card title={`Verification history — ${verifications.length}`}>
          <div className="col" style={{ gap: 8 }}>
            {verifications.map((v) => (
              <div key={v.id} className="spread">
                <div className="col" style={{ gap: 2 }}>
                  <strong style={{ fontSize: 13 }}>{v.action_title ?? "(action)"}</strong>
                  {v.outcome && <div className="muted" style={{ fontSize: 12.5 }}>{v.outcome}</div>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="faint" style={{ fontSize: 11.5 }}>{fmtDate(v.verified_at)}</span>
                  <span className="badge">{v.state}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function ContradictionList({ contradictions }: { contradictions: ContradictionRecord[] }) {
  if (!contradictions.length) return <EmptyState emoji="⚖️" title="No contradictions" body="No recorded evidence contradicts itself." />;
  return (
    <div className="col" style={{ gap: 10 }}>
      {contradictions.map((c) => (
        <Card key={c.id}>
          <div className="spread">
            <div className="row" style={{ gap: 8 }}>
              <strong style={{ textTransform: "capitalize" }}>{c.relationship.toLowerCase()}</strong>
              <Badge className={`sev-${c.status === "open" ? "medium" : "low"}`}>{c.status}</Badge>
            </div>
            <span className="faint mono" style={{ fontSize: 11.5 }}>{c.evidence_a.slice(0, 12)}… ⟷ {c.evidence_b.slice(0, 12)}…</span>
          </div>
          <p className="muted" style={{ margin: "8px 0 0", fontSize: 13.5 }}>{c.reason}</p>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Investigations (exported for the dedicated /app/investigations workspace)
// ---------------------------------------------------------------------------
export function Investigations({
  fieldId,
  investigations,
  setInvestigations,
}: {
  fieldId: string;
  investigations: Investigation[];
  setInvestigations: Dispatch<SetStateAction<Investigation[]>>;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [problem, setProblem] = useState("");
  const [evidence, setEvidence] = useState<EvidenceRecord[]>([]);
  const [selEvidence, setSelEvidence] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    void worldApi.evidence(fieldId, { limit: 60 }).then((r) => setEvidence(r.evidence)).catch(() => undefined);
  }, [fieldId]);

  const create = async () => {
    try {
      const res = await intelApi.createInvestigation(fieldId, {
        title,
        problem,
        trigger: "manual",
        evidence_ids: selEvidence,
        auto: true,
      });
      setInvestigations((prev) => [res.investigation, ...prev]);
      setCreating(false);
      setTitle("");
      setProblem("");
      setSelEvidence([]);
      toast("Investigation opened and enriched against field evidence");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    }
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      {!creating && (
        <div>
          <button className="btn btn-primary" onClick={() => setCreating(true)} type="button">+ Open investigation</button>
        </div>
      )}
      {creating && (
        <Card title="Open an investigation">
          <div className="field">
            <label>Title</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Stunted growth in the north-east corner" />
          </div>
          <div className="field">
            <label>Problem statement</label>
            <textarea className="textarea" value={problem} onChange={(e) => setProblem(e.target.value)} placeholder="Describe what you observed and what you want to understand." />
          </div>
          <div className="field">
            <label>Linked evidence ({selEvidence.length} selected)</label>
            <select className="select" value="" onChange={(e) => {
              const v = e.target.value;
              if (v && !selEvidence.includes(v)) setSelEvidence((s) => [...s, v]);
            }}>
              <option value="">Choose evidence to attach…</option>
              {evidence.map((ev) => (
                <option key={ev.id} value={ev.id}>{ev.domain} · {ev.sub_type} · {ev.measurement ?? ev.state}</option>
              ))}
            </select>
            {selEvidence.length > 0 && (
              <div className="row" style={{ gap: 4, marginTop: 6 }}>
                {selEvidence.map((id) => (
                  <span key={id} className="badge ps-AVAILABLE" onClick={() => setSelEvidence((s) => s.filter((x) => x !== id))} style={{ cursor: "pointer" }}>
                    {id.slice(0, 12)}… ✕
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="row">
            <button className="btn btn-primary" onClick={create} type="button">Create & enrich</button>
            <button className="btn btn-ghost" onClick={() => setCreating(false)} type="button">Cancel</button>
          </div>
        </Card>
      )}

      {investigations.length === 0 && !creating && (
        <EmptyState emoji="🔬" title="No investigations" body="Investigations formalize a problem, attach evidence, and track hypotheses. Open one manually or let the engines auto-investigate." />
      )}

      {investigations.map((inv) => (
        <Card key={inv.id} title={inv.title} right={<Badge className={`sev-${inv.status === "open" ? "medium" : inv.status === "resolved" ? "low" : "info"}`}>{inv.status}</Badge>}>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 13.5 }}>{inv.problem}</p>
          {inv.hypotheses.length > 0 && (
            <div className="col" style={{ gap: 6, margin: "10px 0" }}>
              <div className="section-label">Hypotheses</div>
              {inv.hypotheses.map((h) => (
                <div key={h.id} className="row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 13, flex: 1 }}>{h.statement}</span>
                  <select
                    className="select"
                    style={{ width: 130, padding: "3px 8px", fontSize: 12 }}
                    value={h.status}
                    onChange={(e) => {
                      void intelApi.setHypothesis(inv.id, h.id, e.target.value).then((r) => {
                        setInvestigations((prev) => prev.map((p) => (p.id === inv.id ? r.investigation : p)));
                      });
                    }}
                  >
                    {["proposed", "testing", "supported", "rejected", "inconclusive"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <button className="btn btn-ghost btn-sm" onClick={() => setOpenId(openId === inv.id ? null : inv.id)} type="button">
              {openId === inv.id ? "Hide" : "Details"}
            </button>
          </div>
          {openId === inv.id && <InvestigationDetail inv={inv} onPatch={(updated) => setInvestigations((prev) => prev.map((p) => (p.id === inv.id ? updated : p)))} />}
        </Card>
      ))}
    </div>
  );
}

function InvestigationDetail({ inv, onPatch }: { inv: Investigation; onPatch: (i: Investigation) => void }) {
  const [hyp, setHyp] = useState("");
  const [conclusion, setConclusion] = useState(inv.conclusion ?? "");

  const addHyp = async () => {
    if (!hyp.trim()) return;
    const res = await intelApi.addHypothesis(inv.id, hyp.trim());
    onPatch(res.investigation);
    setHyp("");
  };

  return (
    <div className="grid grid-2 mt-8" style={{ gap: 16 }}>
      <div>
        <div className="section-label">Add hypothesis</div>
        <div className="row">
          <input className="input grow" value={hyp} onChange={(e) => setHyp(e.target.value)} placeholder="Testable hypothesis…" />
          <button className="btn btn-sm" onClick={addHyp} type="button">Add</button>
        </div>
        <div className="section-label mt-16">Conclusion</div>
        <textarea className="textarea" value={conclusion} onChange={(e) => setConclusion(e.target.value)} placeholder="Record the outcome…" />
        <button
          className="btn btn-sm mt-8"
          type="button"
          onClick={async () => {
            const res = await intelApi.patchInvestigation(inv.id, { conclusion: conclusion || null, status: "resolved" });
            onPatch(res.investigation);
            toast("Investigation resolved");
          }}
        >
          Resolve with conclusion
        </button>
        <dl className="kv mt-16" style={{ gridTemplateColumns: "90px 1fr" }}>
          <dt>opened</dt><dd>{fmtDate(inv.created_at)}</dd>
          <dt>trigger</dt><dd className="mono" style={{ fontSize: 12 }}>{inv.trigger}</dd>
          <dt>updated</dt><dd>{timeAgo(inv.updated_at)}</dd>
        </dl>
      </div>
      <div>
        <div className="section-label">Linked evidence ({inv.linked_evidence?.length ?? 0})</div>
        {(!inv.linked_evidence || inv.linked_evidence.length === 0) && <div className="faint" style={{ fontSize: 13 }}>No evidence linked yet.</div>}
        <div className="col" style={{ gap: 4, maxHeight: 300, overflowY: "auto" }}>
          {inv.linked_evidence?.map((e) => (
            <div key={e.id} className="row" style={{ gap: 6, padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 8, background: "rgba(141,199,161,0.04)" }}>
              <TruthBadge state={e.state} />
              <span style={{ fontSize: 12.5, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.domain} · {e.sub_type}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}