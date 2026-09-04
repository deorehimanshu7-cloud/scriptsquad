import { useEffect, useState } from "react";
import { useApp } from "../../lib/state";
import { systemApi, worldApi } from "../../lib/api";
import { Badge, Card, EmptyState, Spinner, Tabs } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate } from "../../lib/format";
import type { MemoryEntry, SystemEvent } from "../../lib/types";

type Tab = "world-model" | "events" | "memory";

export default function History() {
  return (
    <RequireField>
      <HistoryInner />
    </RequireField>
  );
}

function HistoryInner() {
  const { activeField, refreshToken } = useApp();
  const field = activeField!;
  const [tab, setTab] = useState<Tab>("world-model");
  const [wmHistory, setWmHistory] = useState<{ id: string; created_at: string; trigger: string; changed_domains: string[] }[] | null>(null);
  const [events, setEvents] = useState<SystemEvent[] | null>(null);
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);

  useEffect(() => {
    setWmHistory(null);
    setEvents(null);
    setMemory(null);
    void worldApi.worldModelHistory(field.id).then((r) => setWmHistory(r.history)).catch(() => setWmHistory([]));
    void systemApi.events(field.id).then((r) => setEvents(r.events)).catch(() => setEvents([]));
    void worldApi.memory(field.id).then((r) => setMemory(r.memory)).catch(() => setMemory([]));
  }, [field.id, refreshToken]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">History — {field.name}</div>
          <div className="page-sub">
            Versioned world model snapshots, the field's real event log and farm memory. Only actual changes are
            recorded — nothing is synthesized.
          </div>
        </div>
      </div>

      <Tabs
        active={tab}
        onChange={(t) => setTab(t as Tab)}
        tabs={[
          { id: "world-model", label: "World model versions", count: wmHistory?.length ?? 0 },
          { id: "events", label: "Field events", count: events?.length ?? 0 },
          { id: "memory", label: "Farm memory", count: memory?.length ?? 0 },
        ]}
      />

      {tab === "world-model" && (!wmHistory ? <Spinner /> : wmHistory.length === 0 ? (
        <EmptyState emoji="🗂️" title="No world model snapshots" body="Snapshots are written when the pipeline composes the world model for this field." />
      ) : (
        <Card>
          <div className="col" style={{ gap: 6 }}>
            {wmHistory.map((h, i) => (
              <div key={h.id} className="row" style={{ gap: 10, padding: "8px 10px", borderBottom: "1px solid rgba(141,199,161,0.07)" }}>
                <span className="faint mono" style={{ fontSize: 12, width: 150, flexShrink: 0 }}>{fmtDate(h.created_at)}</span>
                <span className="mono" style={{ fontSize: 12 }}>{h.trigger}</span>
                <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                  {h.changed_domains.slice(0, 5).map((d) => (
                    <span key={d} className="badge dom-sensor" style={{ fontSize: 10 }}>{d}</span>
                  ))}
                  {i === 0 && <Badge className="ps-AVAILABLE" style={{ fontSize: 10 }}>latest</Badge>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      ))}

      {tab === "events" && (!events ? <Spinner /> : events.length === 0 ? (
        <EmptyState emoji="📡" title="No events yet" body="Events appear as the worker and your actions change field state." />
      ) : (
        <Card>
          <div className="col" style={{ gap: 4, maxHeight: 640, overflowY: "auto" }}>
            {events.map((e) => (
              <div key={e.id} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "7px 4px", borderBottom: "1px solid rgba(141,199,161,0.06)" }}>
                <span className="faint mono" style={{ fontSize: 11.5, width: 130, flexShrink: 0 }}>{fmtDate(e.created_at)}</span>
                <span className="badge" style={{ fontSize: 10.5, fontFamily: "var(--sans)", textTransform: "none", background: "rgba(93,169,246,0.1)", color: "#7db9f8", borderColor: "rgba(93,169,246,0.25)" }}>
                  {e.type.replace(/_/g, " ").toLowerCase()}
                </span>
                {e.payload !== null && e.payload !== undefined ? (
                  <span className="faint" style={{ fontSize: 11.5, minWidth: 0 }}>{JSON.stringify(e.payload).slice(0, 110)}</span>
                ) : null}
              </div>
            ))}
          </div>
        </Card>
      ))}

      {tab === "memory" && (!memory ? <Spinner /> : memory.length === 0 ? (
        <EmptyState emoji="📓" title="Farm memory is empty" body="Memory is written only when something actually changes: world model updates, resolved investigations, actions." />
      ) : (
        <div className="col" style={{ gap: 8 }}>
          {memory.map((m) => (
            <div key={m.id} className="row" style={{ gap: 10, alignItems: "flex-start", padding: "9px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "rgba(141,199,161,0.04)" }}>
              <span className="faint mono" style={{ fontSize: 12, width: 130, flexShrink: 0 }}>{fmtDate(m.happened_at)}</span>
              <div className="grow">
                <div style={{ fontWeight: 600, fontSize: 13 }}>{m.title}</div>
                {m.summary && <div className="muted" style={{ fontSize: 12.5 }}>{m.summary}</div>}
                <div className="prov-line" style={{ marginTop: 3 }}>{m.kind}{m.ref_id ? ` · ${m.ref_id}` : ""}</div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}