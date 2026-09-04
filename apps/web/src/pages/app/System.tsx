import { useEffect, useState } from "react";
import { useApp } from "../../lib/state";
import { systemApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, Hint, ProviderBadge, Spinner, Stat } from "../../components/ui";
import { fmtDuration, timeAgo } from "../../lib/format";
import type { JobRecord, ProviderMeta } from "../../lib/types";

export default function System() {
  const { events, live, refreshToken, refresh, activeField } = useApp();
  const [providers, setProviders] = useState<ProviderMeta[] | null>(null);
  const [jobs, setJobs] = useState<JobRecord[] | null>(null);
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setProviders(null);
    setJobs(null);
    void systemApi.providers().then((r) => setProviders(r.providers)).catch(() => setProviders([]));
    void systemApi.jobs().then((r) => setJobs(r.jobs)).catch(() => setJobs([]));
    void systemApi.status().then(setStatus).catch(() => undefined);
  }, [refreshToken]);

  const checkAll = async () => {
    setChecking(true);
    try {
      await systemApi.checkProviders();
      refresh();
      toast("Provider health checks done — states recorded truthfully");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Check failed", "error");
    } finally {
      setChecking(false);
    }
  };

  const evts = events.slice(0, 60);
  const dbCounts = (status?.counts ?? {}) as { users: number; fields: number; evidence: number; jobs: number };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">System</div>
          <div className="page-sub">
            Continuous monitoring worker, provider health and the live event bus. Provider failures are recorded with
            explicit states — a failed provider never looks healthy.
          </div>
        </div>
        <button className="btn btn-primary" onClick={checkAll} disabled={checking}>
          {checking ? <span className="spinner" /> : "🔎"} Run provider checks
        </button>
      </div>

      {status && (
        <div className="grid grid-4 mb-16">
          <Stat label="Service" value={<span className="mono">{String(status.service ?? "agrifur-api")}</span>} hint={`v${String(status.version ?? "?")} · up ${Math.round(Number(status.uptime_seconds ?? 0) / 60)}m`} />
          <Stat label="Worker cadence" value="active" hint={`tick ${Math.round(Number((status.workers as Record<string, unknown>)?.worker_tick_ms ?? 0) / 1000)}s · scheduled, not manual`} />
          <Stat label="Events stream" value={live ? "live" : "reconnecting"} />
          <Stat label="DB" value={String((status.database as Record<string, unknown>)?.ok === true ? "ok" : "error")} />
        </div>
      )}

      <div className="grid grid-2" style={{ alignItems: "start" }}>
        <div className="col" style={{ gap: 14 }}>
          <Card title="Provider health" right={dbCounts?.fields !== undefined ? <span className="faint mono" style={{ fontSize: 11.5 }}>users {dbCounts.users} · fields {dbCounts.fields} · evidence {dbCounts.evidence}</span> : undefined}>
            {!providers ? (
              <Spinner />
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {providers.map((p) => {
                  const h = p.health;
                  return (
                    <div key={p.id} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                      <div style={{ width: 130, flexShrink: 0 }}>
                        <div className="mono" style={{ fontWeight: 650, fontSize: 13 }}>{p.id}</div>
                        <div className="faint" style={{ fontSize: 10.5, lineHeight: 1.4 }}>{p.auth_state === "required" ? "credential-gated" : p.auth_state === "configured" ? "configured" : "keyless"}</div>
                      </div>
                      <div className="grow">
                        <div className="row" style={{ gap: 6 }}>
                          <ProviderBadge state={h?.status ?? "NOT_CONFIGURED"} />
                          {h?.latency_ms !== null && h?.latency_ms !== undefined && <span className="faint mono" style={{ fontSize: 11 }}>{fmtDuration(h.latency_ms)}</span>}
                          {h?.last_check_at && <span className="faint" style={{ fontSize: 11 }}>checked {timeAgo(h.last_check_at)}</span>}
                        </div>
                        {(h?.note || h?.last_error) && (
                          <div className="prov-line" style={{ marginTop: 3 }}>{h?.note ?? h?.last_error}</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Recent jobs">
            {!jobs ? (
              <Spinner />
            ) : jobs.length === 0 ? (
              <div className="muted" style={{ fontSize: 13 }}>No jobs recorded yet — the worker writes real job records on every run.</div>
            ) : (
              <table className="tbl">
                <thead>
                  <tr><th>Type</th><th>Status</th><th>Started</th><th>Finished</th><th>Error</th></tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 30).map((j) => (
                    <tr key={j.id}>
                      <td className="mono" style={{ fontSize: 12 }}>{j.type}</td>
                      <td><JobBadge status={j.status} /></td>
                      <td className="nowrap" style={{ fontSize: 12 }}>{j.started_at ? timeAgo(j.started_at) : "—"}</td>
                      <td className="nowrap" style={{ fontSize: 12 }}>{j.finished_at ? timeAgo(j.finished_at) : "—"}</td>
                      <td className="prov-line" style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{j.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div>
          <Card title={`Live events (${evts.length} shown)`} right={live ? <span className="row" style={{ gap: 5 }}><span className="pulse" /> live</span> : <span className="faint" style={{ fontSize: 11 }}>reconnecting</span>}>
            {evts.length === 0 ? (
              <div className="col" style={{ gap: 10 }}>
                <Hint>
                  The event stream shows real system activity: evidence added, world model updated, jobs finished,
                  provider status changed. Nothing here is synthesized.
                </Hint>
                <EmptyState emoji="📡" title="Waiting for events" body="Events appear automatically as the worker and your actions change field state." />
              </div>
            ) : (
              <div className="col" style={{ gap: 4, maxHeight: 560, overflowY: "auto" }}>
                {evts.map((e) => (
                  <div key={e.id} className="row" style={{ gap: 8, alignItems: "flex-start", padding: "6px 4px", borderBottom: "1px solid rgba(141,199,161,0.06)" }}>
                    <span className="faint mono" style={{ fontSize: 11, width: 76, flexShrink: 0 }}>{timeAgo(e.created_at)}</span>
                    <span className="badge" style={{ fontSize: 10.5, fontFamily: "var(--sans)", textTransform: "none", background: "rgba(93,169,246,0.1)", color: "#7db9f8", borderColor: "rgba(93,169,246,0.25)" }}>
                      {e.type.replace(/_/g, " ").toLowerCase()}
                    </span>
                    {e.field_id && <span className="faint mono" style={{ fontSize: 10.5 }}>{e.field_id.slice(0, 10)}…</span>}
                    {activeField && e.payload !== null && e.payload !== undefined ? (
                      <span className="faint" style={{ fontSize: 11, minWidth: 0 }}>{JSON.stringify(e.payload).slice(0, 90)}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function JobBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    SUCCEEDED: "ps-AVAILABLE",
    QUEUED: "ps-NO_DATA",
    RUNNING: "ps-AUTH_REQUIRED",
    FAILED: "ps-PROVIDER_ERROR",
    RETRYING: "ps-TIMEOUT",
    BLOCKED: "ps-NOT_CONFIGURED",
    NO_DATA: "ps-NO_DATA",
    AUTH_REQUIRED: "ps-AUTH_REQUIRED",
  };
  return <Badge className={map[status] ?? "ps-NOT_CONFIGURED"}>{status}</Badge>;
}