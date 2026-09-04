import { useEffect, useState } from "react";
import { useApp } from "../../lib/state";
import { farmerApi, toast, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, Spinner, Tabs } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, timeAgo } from "../../lib/format";
import type { FarmerObservation, MemoryEntry } from "../../lib/types";

type Tab = "observations" | "memory";

export default function Notes() {
  return (
    <RequireField>
      <NotesInner />
    </RequireField>
  );
}

const TAGS = ["reported_no_rain", "pest_sighting", "growth_issue", "irrigation_done", "crop_damage", "other"];

function NotesInner() {
  const { activeField, refreshToken, refresh } = useApp();
  const field = activeField!;
  const [tab, setTab] = useState<Tab>("observations");
  const [obs, setObs] = useState<FarmerObservation[] | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [history, setHistory] = useState<{ id: string; created_at: string; trigger: string; changed_domains: string[] }[] | null>(null);
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setObs(null);
    setMemory(null);
    setHistory(null);
    void farmerApi.list(field.id).then((r) => setObs(r.observations)).catch(() => setObs([]));
    void worldApi.memory(field.id).then((r) => setMemory(r.memory)).catch(() => setMemory([]));
    void worldApi.worldModelHistory(field.id).then((r) => setHistory(r.history)).catch(() => setHistory([]));
  }, [field.id, refreshToken]);

  const add = async () => {
    if (text.trim().length < 2) return;
    setBusy(true);
    try {
      await farmerApi.add(field.id, { text: text.trim(), tags });
      setText("");
      setTags([]);
      toast("Farmer observation recorded (state: OBSERVED, farmer-reported — not independently verified)");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Notes & memory — {field.name}</div>
          <div className="page-sub">
            Farmer input enters the evidence layer as OBSERVED (farmer-reported) until verified. Farm memory records
            actual world-model changes, actions and resolutions — never synthetic history.
          </div>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(t) => setTab(t as Tab)}
        tabs={[
          { id: "observations", label: "Farmer observations", count: obs?.length ?? 0 },
          { id: "memory", label: "Farm memory", count: memory?.length ?? 0 },
        ]}
      />

      {tab === "observations" ? (
        <>
          <Card>
            <div className="field" style={{ margin: 0 }}>
              <label>Record what you saw in the field</label>
              <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. The north-east corner looks stunted compared to the rest of the plot." />
            </div>
            <div className="row" style={{ gap: 6, margin: "10px 0" }}>
              {TAGS.map((t) => (
                <button
                  key={t}
                  className={`btn btn-sm ${tags.includes(t) ? "btn-primary" : "btn-ghost"}`}
                  onClick={() => setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))}
                  type="button"
                >
                  {t.replace(/_/g, " ")}
                </button>
              ))}
            </div>
            <button className="btn btn-primary" onClick={add} disabled={busy || text.trim().length < 2} type="button">Record observation</button>
          </Card>

          {!obs ? (
            <Spinner />
          ) : obs.length === 0 ? (
            <EmptyState emoji="👩‍🌾" title="No farmer observations yet" body="Observations are treated as evidence (farmer-reported, OBSERVED) and feed the contradiction engine." />
          ) : (
            <div className="col mt-16" style={{ gap: 10 }}>
              {obs.map((o) => (
                <Card key={o.id}>
                  <div className="spread">
                    <div className="row" style={{ gap: 6 }}>
                      <Badge className="ts-OBSERVED">OBSERVED</Badge>
                      <Badge className={`sev-${o.verified ? "low" : "info"}`}>{o.verified ? "verified" : "farmer-reported"}</Badge>
                    </div>
                    <span className="faint" style={{ fontSize: 12 }}>{fmtDate(o.created_at)}</span>
                  </div>
                  <p style={{ margin: "10px 0 6px", fontSize: 13.5 }}>{o.text}</p>
                  <div className="row" style={{ gap: 4 }}>
                    {o.tags.map((t) => (
                      <span key={t} className="badge dom-farmer">{t}</span>
                    ))}
                    {!o.verified && (
                      <button
                        className="btn btn-ghost btn-sm"
                        type="button"
                        style={{ marginLeft: "auto" }}
                        onClick={async () => {
                          await farmerApi.verify(field.id, o.id, true);
                          refresh();
                        }}
                      >
                        Mark verified
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="grid grid-2" style={{ alignItems: "start" }}>
            <div>
              {!memory ? (
                <Spinner />
              ) : memory.length === 0 ? (
                <EmptyState emoji="📓" title="Farm memory is empty" body="Memory is written only when something actually changes: a world-model update, an investigation resolved, an action taken." />
              ) : (
                <div className="col" style={{ gap: 8 }}>
                  {memory.map((m) => (
                    <div key={m.id} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "8px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "rgba(141,199,161,0.04)" }}>
                      <span className="mono" style={{ color: "var(--text-faint)", fontSize: 12 }}>{fmtDate(m.happened_at)}</span>
                      <div className="grow">
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{m.title}</div>
                        {m.summary && <div className="muted" style={{ fontSize: 12.5 }}>{m.summary}</div>}
                        <div className="prov-line mt-8" style={{ marginTop: 3 }}>{m.kind}{m.ref_id ? ` · ${m.ref_id}` : ""}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              {!history ? (
                <Spinner />
              ) : history.length === 0 ? (
                <div className="faint" style={{ fontSize: 13 }}>No world model snapshots yet.</div>
              ) : (
                <Card title="World model history">
                  <div className="col" style={{ gap: 6 }}>
                    {history.slice(0, 30).map((h, i) => (
                      <div key={h.id} className="row" style={{ gap: 8 }}>
                        <span className="faint mono" style={{ fontSize: 11.5, width: 110 }}>{timeAgo(h.created_at)}</span>
                        <span className="mono" style={{ fontSize: 11.5 }}>{h.trigger}</span>
                        <span className="row" style={{ gap: 3, flexWrap: "wrap" }}>
                          {h.changed_domains.slice(0, 4).map((d) => (
                            <span key={d} className="badge dom-sensor" style={{ fontSize: 10 }}>{d}</span>
                          ))}
                          {i === 0 && <span className="badge ps-AVAILABLE" style={{ fontSize: 10 }}>latest</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}