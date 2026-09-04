import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../lib/state";
import { farmApi, systemApi, worldApi, toast } from "../../lib/api";
import { Card, EmptyState, Hint, ProviderBadge, Spinner, Tabs, TruthBadge } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, timeAgo } from "../../lib/format";
import type { Domain, EvidenceRecord, ProviderMeta } from "../../lib/types";

/**
 * Dedicated evidence-layer workspace. Every number comes from the API with its
 * truth state; providers render their real health; empty layers show explicit
 * NO_DATA / NOT_CONFIGURED / AUTH_REQUIRED states with the reason — never
 * fabricated values.
 */
export function DomainWorkspace({
  domain,
  title,
  icon,
  blurb,
  providers = [],
  editableCrop = false,
}: {
  domain: Domain;
  title: string;
  icon: string;
  blurb: string;
  providers?: string[];
  editableCrop?: boolean;
}) {
  return (
    <RequireField>
      <Inner domain={domain} title={title} icon={icon} blurb={blurb} providers={providers} editableCrop={editableCrop} />
    </RequireField>
  );
}

function Inner({ domain, title, icon, blurb, providers, editableCrop }: { domain: Domain; title: string; icon: string; blurb: string; providers: string[]; editableCrop: boolean }) {
  const { activeField, refreshToken, refresh } = useApp();
  const field = activeField!;
  const [evidence, setEvidence] = useState<EvidenceRecord[] | null>(null);
  const [providerRows, setProviderRows] = useState<ProviderMeta[] | null>(null);
  const [domainState, setDomainState] = useState<{ state: string; summary: string; count: number } | null>(null);
  const [cropDraft, setCropDraft] = useState(field.crop_name ?? "");
  const [savingCrop, setSavingCrop] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEvidence(null);
    setDomainState(null);
    void worldApi
      .evidence(field.id, { domain, limit: 250 })
      .then((r) => {
        if (!cancelled) setEvidence(r.evidence);
      })
      .catch(() => {
        if (!cancelled) setEvidence([]);
      });
    void worldApi.worldModel(field.id).then((r) => {
      if (cancelled || !r.world_model) return;
      const snap = r.world_model.snapshot as unknown as { domains?: { domain: string; state: string; summary: string; count: number }[] };
      const d = snap.domains?.find((x) => x.domain === domain);
      if (d) setDomainState({ state: d.state, summary: d.summary, count: d.count });
    }).catch(() => undefined);
    if (providers.length > 0) {
      void systemApi.providers().then((r) => {
        if (!cancelled) setProviderRows(r.providers.filter((p) => providers.includes(p.id)));
      }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [field.id, domain, providers.join(","), refreshToken]);

  const latestByType = useMemo(() => {
    const m = new Map<string, EvidenceRecord>();
    for (const e of evidence ?? []) if (!m.has(e.sub_type)) m.set(e.sub_type, e);
    return [...m.values()];
  }, [evidence]);

  const refreshNow = async () => {
    setRunning(true);
    try {
      const res = await worldApi.refresh(field.id);
      toast(res.note ?? "Pipeline refreshed");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Refresh failed", "error");
    } finally {
      setRunning(false);
    }
  };

  const saveCrop = async () => {
    setSavingCrop(true);
    try {
      const res = await farmApi.patchField(field.id, { crop_name: cropDraft.trim() || null });
      toast(res.field.crop_name ? `Crop declared: ${res.field.crop_name}` : "Crop cleared");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setSavingCrop(false);
    }
  };

  const tabs = [
    { id: "latest", label: "Latest per variable" },
    { id: "all", label: "All records", count: evidence?.length ?? 0 },
  ];
  const [tab, setTab] = useState("latest");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">
            {icon} {title} — {field.name}
          </div>
          <div className="page-sub">{blurb}</div>
        </div>
        <button className="btn" onClick={refreshNow} disabled={running}>
          {running ? <span className="spinner" /> : "🔄"} Refresh pipeline
        </button>
      </div>

      {providers.length > 0 && providerRows !== null && (
        <div className="grid grid-3 mb-16">
          {providerRows.map((p) => (
            <Card key={p.id} title={`Provider · ${p.id}`}>
              <div className="row" style={{ gap: 6 }}>
                <ProviderBadge state={p.health?.status ?? "NOT_CONFIGURED"} />
                {p.health?.last_check_at && <span className="faint" style={{ fontSize: 11.5 }}>checked {timeAgo(p.health.last_check_at)}</span>}
              </div>
              {(p.health?.note || p.health?.last_error) && (
                <div className="prov-line" style={{ marginTop: 6 }}>{p.health?.note ?? p.health?.last_error}</div>
              )}
            </Card>
          ))}
        </div>
      )}

      {editableCrop && (
        <Card className="mb-16">
          <div className="grid grid-2" style={{ gap: 12, alignItems: "end" }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Declared crop (field metadata — not independently verified)</label>
              <input className="input" value={cropDraft} onChange={(e) => setCropDraft(e.target.value)} placeholder="e.g. Soybean" />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary" onClick={saveCrop} disabled={savingCrop || !cropDraft.trim()}>Save crop</button>
            </div>
          </div>
        </Card>
      )}

      {domainState && (
        <Hint warn={["NO_DATA", "NOT_CONFIGURED", "AUTH_REQUIRED", "DATA_QUALITY_FAILURE", "UNKNOWN"].includes(domainState.state)}>
          <span className="row" style={{ gap: 6 }}>
            {["NO_DATA", "NOT_CONFIGURED", "AUTH_REQUIRED", "DATA_QUALITY_FAILURE"].includes(domainState.state) ? (
              <ProviderBadge state={domainState.state} />
            ) : (
              <TruthBadge state={domainState.state as never} />
            )}
            <strong>{domainState.count} record(s)</strong>
          </span>
          <div className="mt-8" style={{ fontSize: 12.5 }}>{domainState.summary}</div>
        </Hint>
      )}

      <div className="mt-16">
        {!evidence ? (
          <Spinner label={`Loading ${title.toLowerCase()} evidence…`} />
        ) : evidence.length === 0 ? (
          <EmptyState
            emoji="📭"
            title={`${title}: ${domainState?.state ?? "NO_DATA"}`}
            body={domainState?.summary ?? "No evidence recorded for this layer yet. Run the pipeline to check providers."}
            action={<button className="btn btn-primary" onClick={refreshNow} disabled={running}>Check providers now</button>}
          />
        ) : (
          <>
            <Tabs active={tab} onChange={setTab} tabs={tabs} />
            {tab === "latest" ? (
              <div className="grid grid-3">
                {latestByType.slice(0, 9).map((e) => (
                  <Card key={e.id} title={e.sub_type} right={<TruthBadge state={e.state} />}>
                    <div className="val-lg">
                      {e.value !== null ? (
                        <>
                          {e.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          {e.unit && <span className="val-unit">{e.unit}</span>}
                        </>
                      ) : (
                        <span className="faint">text / n/a</span>
                      )}
                    </div>
                    {e.measurement && <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{e.measurement}</div>}
                    <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>observed {fmtDate(e.observed_at)} · {e.source}</div>
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Variable</th>
                      <th>Measurement</th>
                      <th>Value</th>
                      <th>State</th>
                      <th>Observed</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {evidence.map((e) => (
                      <tr key={e.id}>
                        <td className="mono" style={{ fontSize: 12 }}>{e.sub_type}</td>
                        <td style={{ fontSize: 12.5 }}>{e.measurement ?? "—"}</td>
                        <td className="mono-val nowrap">
                          {e.value !== null ? (
                            <>
                              {e.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                              {e.unit && <span className="val-unit">{e.unit}</span>}
                            </>
                          ) : (
                            <span className="faint">—</span>
                          )}
                        </td>
                        <td><TruthBadge state={e.state} /></td>
                        <td className="nowrap" style={{ fontSize: 12 }}>{fmtDate(e.observed_at)}</td>
                        <td style={{ fontSize: 12 }}>{e.source}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}