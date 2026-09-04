import { useEffect, useMemo, useState } from "react";
import { useApp } from "../../lib/state";
import { hardwareApi, toast } from "../../lib/api";
import { Badge, Card, EmptyState, FieldValue, Hint, Spinner, Stat } from "../../components/ui";
import { RequireField } from "./AppLayout";
import { fmtDate, timeAgo } from "../../lib/format";
import type { DeviceRecord, ObservationRow } from "../../lib/types";

export default function Sensors() {
  return (
    <RequireField>
      <SensorsInner />
    </RequireField>
  );
}

function SensorsInner() {
  const { activeField, refreshToken, refresh, providers } = useApp();
  const field = activeField!;
  const [devices, setDevices] = useState<DeviceRecord[] | null>(null);
  const [observations, setObservations] = useState<ObservationRow[] | null>(null);
  const [sensorType, setSensorType] = useState<string>("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [kind, setKind] = useState<"sensor_node" | "voice_device" | "gateway">("sensor_node");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDevices(null);
    setObservations(null);
    void hardwareApi.devices(field.id).then((r) => setDevices(r.devices)).catch(() => setDevices([]));
    void hardwareApi.observations(field.id).then((r) => setObservations(r.observations)).catch(() => setObservations([]));
  }, [field.id, refreshToken]);

  const types = useMemo(() => {
    const m = new Map<string, ObservationRow[]>();
    for (const o of observations ?? []) {
      const arr = m.get(o.sensor_type) ?? [];
      arr.push(o);
      m.set(o.sensor_type, arr);
    }
    return [...m.entries()].map(([t, rows]) => ({ type: t, rows: rows.sort((a, b) => a.observed_at.localeCompare(b.observed_at)) }));
  }, [observations]);

  const activeRows = sensorType ? (types.find((t) => t.type === sensorType)?.rows ?? []) : [];

  const register = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await hardwareApi.registerDevice(field.id, {
        name: name.trim(),
        device_id: deviceId.trim() || null,
        kind,
        firmware_version: "0.0.0",
        metadata: { note: "Registered from the web console. No telemetry until a real gateway posts readings." },
      });
      setName("");
      setDeviceId("");
      setShowForm(false);
      toast("Device registered. It will show WAITING_FOR_TELEMETRY until a real gateway posts readings.");
      refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const online = devices?.filter((d) => d.effective_status === "online").length ?? 0;
  const mqttProvider = providers.find((p) => p.id === "mqtt-broker");

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-title">Physical sensors — {field.name}</div>
          <div className="page-sub">
            Hardware gateway endpoints accept real telemetry over HTTPS with dedupe and provenance. The UI never
            fabricates readings — an idle device shows NO_DATA, not fake values.
          </div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowForm((s) => !s)} type="button">
          {showForm ? "Close" : "+ Register device"}
        </button>
      </div>

      {showForm && (
        <Card className="mb-16">
          <div className="grid grid-3" style={{ gap: 12 }}>
            <div className="field" style={{ margin: 0 }}>
              <label>Device name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Field Node-01" />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Firmware device id (MQTT)</label>
              <input className="input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} placeholder="AGRIFUR-ESP32-001" />
              <span className="faint" style={{ fontSize: 10.5 }}>must match the id the firmware publishes</span>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>Kind</label>
              <select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="sensor_node">sensor_node</option>
                <option value="gateway">gateway</option>
                <option value="voice_device">voice_device</option>
              </select>
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary" onClick={register} disabled={busy || !name.trim()}>Register</button>
            <span className="faint" style={{ fontSize: 11 }}>
              Registration is real state — the device shows WAITING_FOR_TELEMETRY until the physical gateway posts.
            </span>
          </div>
          <Hint warn className="mt-8" >
            Registering a device is real state. It will show “registered — no telemetry” until the physical gateway
            posts observations to <span className="mono">POST /api/fields/:id/observations</span>.
          </Hint>
        </Card>
      )}

      {mqttProvider && (
        <Card className="mb-16">
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <Badge className={`ps-${(mqttProvider.health?.status ?? "NOT_CONFIGURED") === "AVAILABLE" ? "AVAILABLE" : (mqttProvider.health?.status ?? "NOT_CONFIGURED") === "UNAVAILABLE" ? "PROVIDER_ERROR" : "NOT_CONFIGURED"}`}>
              {mqttProvider.health?.status === "AVAILABLE"
                ? "MQTT broker AVAILABLE"
                : mqttProvider.health?.status === "UNAVAILABLE"
                  ? "MQTT_UNAVAILABLE — broker unreachable"
                  : "MQTT NOT_CONFIGURED"}
            </Badge>
            <span className="muted" style={{ fontSize: 12.5, flex: 1, minWidth: 220 }}>
              Physical telemetry transport: <strong>MQTT</strong> (ESP32 → LAN Mosquitto, port 1883) or the HTTPS
              gateway. Set <span className="mono">MQTT_BROKER_URL</span> on the API server to activate the subscriber.
            </span>
            {mqttProvider.health?.last_error && (
              <span className="faint mono" style={{ fontSize: 11, width: "100%" }}>{mqttProvider.health.last_error}</span>
            )}
          </div>
        </Card>
      )}

      {!devices ? (
        <Spinner label="Loading devices…" />
      ) : devices.length === 0 ? (
        <EmptyState
          emoji="📡"
          title="No devices on this field"
          body="Register a device here, then connect your ESP32/Arduino gateway to the MQTT broker (LAN) or the HTTPS observations endpoint. Telemetry will appear as OBSERVED."
          action={<button className="btn btn-primary" onClick={() => setShowForm(true)} type="button">+ Register device</button>}
        />
      ) : (
        <div className="grid grid-3 mb-16">
          <Stat label="Devices" value={devices.length} />
          <Stat label="Online" value={online} hint="heartbeat within the last 2 minutes; stale/offline never shown as online" />
          <Stat label="Observation records" value={observations?.length ?? 0} />
        </div>
      )}

      {devices && devices.length > 0 && (
        <div className="grid grid-3 mt-8">
          {devices.map((d) => (
            <Card key={d.id} title={d.name}>
              <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                <DeviceStatusBadge d={d} />
                <Badge className="dom-sensor">{d.kind}</Badge>
                {d.external_id && <span className="mono faint" style={{ fontSize: 11 }}>{d.external_id}</span>}
              </div>
              <dl className="kv" style={{ gridTemplateColumns: "100px 1fr", fontSize: 12.5 }}>
                <dt>firmware</dt><dd className="mono">{d.firmware_version ?? "—"}</dd>
                <dt>last seen</dt><dd>{d.last_seen_at ? `${timeAgo(d.last_seen_at)}${d.seconds_since_seen != null ? ` (${Math.floor(d.seconds_since_seen / 60)} min ago)` : ""}` : "never"}</dd>
                <dt>telemetry</dt><dd>{d.telemetry_count > 0 ? `${d.telemetry_count} record(s) · last ${d.last_telemetry_at ? timeAgo(d.last_telemetry_at) : "—"}` : <span className="faint">WAITING_FOR_TELEMETRY</span>}</dd>
                <dt>id</dt><dd className="mono prov-line">{d.id}</dd>
              </dl>
            </Card>
          ))}
        </div>
      )}

      <Card title="Observation time series" className="mt-16">
        {!observations ? (
          <Spinner />
        ) : observations.length === 0 ? (
          <div className="muted" style={{ fontSize: 13, padding: 8 }}>
            No telemetry recorded. Real readings will stream here as <strong>OBSERVED</strong> values with device
            provenance. Nothing is simulated.
          </div>
        ) : (
          <>
            <div className="row mb-16" style={{ gap: 6 }}>
              <button className={`btn btn-sm ${sensorType === "" ? "btn-primary" : "btn-ghost"}`} onClick={() => setSensorType("")} type="button">All</button>
              {types.map((t) => (
                <button key={t.type} className={`btn btn-sm ${sensorType === t.type ? "btn-primary" : "btn-ghost"}`} onClick={() => setSensorType(t.type)} type="button">
                  {t.type} ({t.rows.length})
                </button>
              ))}
            </div>

            {sensorType && activeRows.length > 1 && (
              <Chart rows={activeRows} unit={activeRows[0].unit} />
            )}

            <table className="tbl">
              <thead>
                <tr><th>Time</th><th>Sensor</th><th>Value</th><th>Quality</th><th>Device</th></tr>
              </thead>
              <tbody>
                {(sensorType ? activeRows : [...(observations ?? [])].sort((a, b) => b.observed_at.localeCompare(a.observed_at))).map((o) => (
                  <tr key={o.id}>
                    <td className="nowrap">{fmtDate(o.observed_at)}</td>
                    <td className="mono">{o.sensor_type}</td>
                    <td><FieldValue value={o.value} unit={o.unit} /></td>
                    <td>{o.quality ? <Badge className={`sev-${o.quality === "high" ? "low" : o.quality}`}>{o.quality}</Badge> : <span className="faint">—</span>}</td>
                    <td className="mono prov-line">{o.device_id.slice(0, 16)}…</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
}

/** Honest device health badge — computed server-side from real last_seen_at. */
function DeviceStatusBadge({ d }: { d: DeviceRecord }) {
  const map: Record<DeviceRecord["effective_status"], { cls: string; label: string }> = {
    online: { cls: "ps-AVAILABLE", label: "ONLINE" },
    stale: { cls: "ps-RATE_LIMITED", label: "STALE" },
    offline: { cls: "ps-PROVIDER_ERROR", label: "OFFLINE" },
    registered: { cls: "ps-NOT_CONFIGURED", label: "REGISTERED · WAITING_FOR_TELEMETRY" },
    error: { cls: "ps-PROVIDER_ERROR", label: "ERROR" },
  };
  const m = map[d.effective_status] ?? map.registered;
  return <Badge className={m.cls}>{m.label}</Badge>;
}

/** Minimal inline sparkline — no chart dependency needed. */
function Chart({ rows, unit }: { rows: ObservationRow[]; unit: string | null }) {
  const w = 600;
  const h = 70;
  const values = rows.map((r) => r.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / Math.max(values.length - 1, 1)) * w).toFixed(1)},${(h - 6 - ((v - min) / span) * (h - 14)).toFixed(1)}`)
    .join(" ");
  return (
    <div className="mb-16" style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 10, background: "rgba(12,23,17,0.6)" }}>
      <div className="faint" style={{ fontSize: 11, marginBottom: 6 }}>
        {rows[0].sensor_type} · {rows.length} readings · range {min.toLocaleString()}–{max.toLocaleString()} {unit ?? ""}
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 90 }}>
        <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" />
      </svg>
    </div>
  );
}