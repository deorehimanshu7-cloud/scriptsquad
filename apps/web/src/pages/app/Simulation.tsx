import { useEffect, useState } from "react";
import { useApp } from "../../lib/state";
import { simApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, Hint, Spinner } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, fmtNum } from "../../lib/format";
import type { SimulationRecord } from "../../lib/types";

interface RunOutput {
  state: string;
  model: string;
  inputs: { rainfall_mm: number; irrigation_mm: number; crop_factor_kc: number; days: number; et0_mm?: number; et0_source?: "uniform" | "field_climate" };
  daily: { day: number; rain_mm?: number; et_mm?: number; balance_mm: number; cumulative_mm: number }[];
  cumulative_end_mm: number;
  source?: "uniform" | "field_climate";
  climate?: { days_used: number; horizon_days: number; note: string };
  assumptions?: string;
  limitations?: string;
  disclaimer?: string;
}

export default function Simulation() {
  return (
    <RequireField>
      <SimInner />
    </RequireField>
  );
}

function SimInner() {
  const { activeField, refreshToken, refresh } = useApp();
  const field = activeField!;
  const [sims, setSims] = useState<SimulationRecord[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [scenario, setScenario] = useState("");
  const [rainfall, setRainfall] = useState(0);
  const [irrigation, setIrrigation] = useState(0);
  const [kc, setKc] = useState(1);
  const [days, setDays] = useState(30);
  const [useClimate, setUseClimate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [outputs, setOutputs] = useState<Record<string, RunOutput>>({});

  useEffect(() => {
    setSims(null);
    void simApi
      .list(field.id)
      .then(async (r) => {
        setSims(r.simulations);
        // restore the latest run output of every scenario so results survive reloads
        const latest = new Map<string, RunOutput>();
        await Promise.all(
          r.simulations.map(async (s) => {
            try {
              const runs = await simApi.runs(s.id);
              const last = runs.runs[runs.runs.length - 1];
              if (last) latest.set(s.id, last.output as unknown as RunOutput);
            } catch {
              /* no runs / offline — leave empty */
            }
          }),
        );
        if (latest.size > 0) setOutputs((o) => ({ ...o, ...Object.fromEntries(latest) }));
      })
      .catch(() => setSims([]));
  }, [field.id, refreshToken]);

  const create = async () => {
    if (!name.trim() || !scenario.trim()) return;
    setBusy(true);
    try {
      await simApi.create(field.id, {
        name: name.trim(),
        scenario: scenario.trim(),
        inputs: { rainfall_mm: rainfall, irrigation_mm: irrigation, crop_factor_kc: kc, days, et0_source: useClimate ? "field_climate" : "uniform" },
      });
      setName("");
      setScenario("");
      setShowForm(false);
      toast("Scenario created (SIMULATED — kept separate from observed evidence)");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const run = async (sim: SimulationRecord) => {
    setRunningId(sim.id);
    try {
      const res = await simApi.run(sim.id);
      setOutputs((o) => ({ ...o, [sim.id]: res.run.output as unknown as RunOutput }));
      toast("Simulation run completed (SIMULATED output)");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Run failed", "error");
    } finally {
      setRunningId(null);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Simulation — {field.name}</div>
          <div className="page-sub">
            Deterministic water-balance scenarios over user inputs. All output rows are state SIMULATED, never merged
            into observed evidence, and never presented as predictions of reality.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} type="button">
          {showForm ? "Close" : "+ New scenario"}
        </button>
      </div>

      <Hint warn>
        <strong>Truthfulness:</strong> simulation output is labelled <Badge className="ts-SIMULATED">SIMULATED</Badge> in
        the world model. It does not influence risks, anomalies or advisories derived from observed evidence.
      </Hint>

      {showForm && (
        <Card className="mt-16">
          <div className="grid grid-2" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Scenario name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rainfed kharif, normal monsoon" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Question / scenario</label>
              <input className="input" value={scenario} onChange={(e) => setScenario(e.target.value)} placeholder="What happens if…?" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>{useClimate ? "Extra rainfall per day (mm) — added on top of real evidence" : "Rainfall per day (mm) — uniform assumption"}</label>
              <input className="input" type="number" min={0} max={1000} value={rainfall} onChange={(e) => setRainfall(Number(e.target.value))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Irrigation per day (mm) — uniform assumption</label>
              <input className="input" type="number" min={0} max={2000} value={irrigation} onChange={(e) => setIrrigation(Number(e.target.value))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Crop factor Kc</label>
              <input className="input" type="number" step={0.1} min={0.1} max={1.5} value={kc} onChange={(e) => setKc(Number(e.target.value))} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Horizon (days)</label>
              <input className="input" type="number" min={1} max={180} value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </div>
          </div>
          <label className="row mt-16" style={{ gap: 8, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={useClimate} onChange={(e) => setUseClimate(e.target.checked)} />
            <span style={{ fontSize: 13 }}>
              <strong>Use this field’s real recent climate</strong> — daily rain/ET0 baseline from recorded weather
              evidence (fallback: uniform inputs above). Output stays SIMULATED.
            </span>
          </label>
          <div className="row mt-16">
            <button className="btn btn-primary" onClick={create} disabled={busy}>Create scenario</button>
          </div>
        </Card>
      )}

      <div className="mt-16">
        {!sims ? (
          <Spinner label="Loading scenarios…" />
        ) : sims.length === 0 ? (
          <EmptyState
            emoji="🧪"
            title="No simulation scenarios yet"
            body="Scenarios are explicit what-if runs over uniform daily inputs — clearly separated from observed reality."
            action={<button className="btn btn-primary" onClick={() => setShowForm(true)} type="button">+ New scenario</button>}
          />
        ) : (
          <div className="col" style={{ gap: 12 }}>
            {sims.map((s) => {
              const out = outputs[s.id];
              return (
                <Card key={s.id} title={s.name} right={<Badge className="ts-SIMULATED">SIMULATED</Badge>}>
                  <div className="spread">
                    <p className="muted" style={{ margin: 0, fontSize: 13, maxWidth: 700 }}>{s.scenario}</p>
                    <button className="btn btn-sm btn-primary" onClick={() => run(s)} disabled={runningId === s.id} type="button">
                      {runningId === s.id ? <span className="spinner" /> : "▶"} Run
                    </button>
                  </div>
                  <div className="prov-line mt-8">model: {s.model} v{s.model_version} · created {fmtDate(s.created_at)}</div>
                  {out ? (
                    <div className="mt-16">
                      <div className="row" style={{ gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
                        <Badge className="ts-SIMULATED badge-lg">{out.state}</Badge>
                        <span className="faint mono" style={{ fontSize: 12 }}>end balance {fmtNum(out.cumulative_end_mm)} mm over {out.inputs.days}d</span>
                        <Badge className={out.source === "field_climate" ? "ps-AVAILABLE" : "ps-NO_DATA"}>
                          {out.source === "field_climate" ? "baseline: field climate" : "baseline: uniform"}
                        </Badge>
                      </div>
                      {out.climate && <p className="faint" style={{ fontSize: 12, margin: "0 0 8px" }}>{out.climate.note}</p>}
                      <BarChart daily={out.daily} />
                      <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>{out.disclaimer}</div>
                    </div>
                  ) : (
                    <div className="faint mt-8" style={{ fontSize: 12 }}>Not run yet — press ▶ Run to execute this SIMULATED scenario.</div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function BarChart({ daily }: { daily: { day: number; balance_mm: number; cumulative_mm: number }[] }) {
  const w = 800;
  const h = 130;
  const max = Math.max(...daily.map((d) => d.balance_mm), 1);
  const min = Math.min(...daily.map((d) => d.balance_mm), 0);
  const range = max - min || 1;
  const bw = w / daily.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 140, background: "rgba(12,23,17,0.6)", borderRadius: 10, border: "1px solid var(--border)" }}>
      {daily.map((d, i) => {
        const zeroY = h - 12 - ((-min) / range) * (h - 24);
        const valH = (Math.abs(d.balance_mm) / range) * (h - 24);
        const y = d.balance_mm >= 0 ? zeroY - valH : zeroY;
        return (
          <rect
            key={d.day}
            x={i * bw + 1}
            y={y}
            width={Math.max(bw - 2, 1)}
            height={Math.max(valH, 1)}
            fill={d.balance_mm >= 0 ? "var(--accent)" : "var(--red)"}
            opacity={0.8}
          >
            <title>{`day ${d.day}: balance ${d.balance_mm} mm · cumulative ${d.cumulative_mm} mm`}</title>
          </rect>
        );
      })}
      <line x1={0} x2={w} y1={h - 12 - ((-min) / range) * (h - 24)} y2={h - 12 - ((-min) / range) * (h - 24)} stroke="var(--text-faint)" strokeWidth="1" strokeDasharray="4 3" />
    </svg>
  );
}