import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';
import { Panel, StateChip, LoadingState, ErrorState, EmptyState, GenericTable, InfoNote } from '@/components/ui/kit';

export default function SensorsPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const fieldId = currentField?.id;

  const [devices, setDevices] = useState<any[]>([]);
  const [deployments, setDeployments] = useState<any[]>([]);
  const [sensors, setSensors] = useState<any[]>([]);
  const [latest, setLatest] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // register form
  const [form, setForm] = useState({ name: '', type: 'soil_moisture_probe', serial_number: '' });
  const [apiKey, setApiKey] = useState<string | null>(null);
  // sensor form
  const [sForm, setSForm] = useState({ device_id: '', sensor_type: 'soil_moisture', unit: '%' });

  async function loadAll(silent = false) {
    if (!fieldId) return;
    if (!silent) { setBusy(true); setError(null); }
    try {
      const [d, s, o, h] = await Promise.all([
        api.get<any>(`/fields/${fieldId}/devices`),
        api.get<any>(`/fields/${fieldId}/sensors`),
        api.get<any>(`/fields/${fieldId}/observations/timeseries`),
        api.get<any>(`/fields/${fieldId}/hardware-health`),
      ]);
      setDevices(d.data?.devices || []);
      setDeployments(d.data?.deployments || []);
      setSensors(s.data || []);
      setLatest(o.data || []);
      setHealth(h.data || null);
      setLastRefresh(new Date());
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
    finally { if (!silent) setBusy(false); }
  }

  useEffect(() => {
    // FIELD ISOLATION: empty the previous field's hardware state first.
    setDevices([]); setDeployments([]); setSensors([]); setLatest([]); setHealth(null);
    if (!fieldId) return;
    loadAll();
    // live telemetry poll (silent refresh keeps readings current)
    const id = setInterval(() => loadAll(true), 20000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, [fieldId]);

  async function registerDevice() {
    if (!form.name || !form.type) return setFlash('Device name and type are required.');
    setError(null); setFlash(null);
    try {
      const r = await api.post<any>('/devices/register', { name: form.name, type: form.type, serial_number: form.serial_number || undefined, field_id: fieldId });
      setApiKey(r.data.device_key);
      setForm({ name: '', type: form.type, serial_number: '' });
      setFlash(`Device registered. Store the key on the device — it is shown only once.`);
      loadAll();
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
  }

  async function deploy(deviceId: string) {
    if (!fieldId) return;
    setError(null);
    const c = currentField?.centroid?.coordinates as [number, number] | undefined;
    try {
      await api.post<any>(`/fields/${fieldId}/devices/${deviceId}/deploy`, {
        location: c ? { type: 'Point', coordinates: c } : undefined,
      });
      setFlash('Device deployed to this field.');
      loadAll();
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
  }

  async function addSensor() {
    if (!sForm.device_id || !sForm.sensor_type) return setFlash('Pick a device and a sensor type.');
    try {
      await api.post<any>(`/fields/${fieldId}/sensors`, {
        device_id: sForm.device_id, sensor_type: sForm.sensor_type, unit: sForm.unit || undefined,
      });
      setFlash('Sensor registered on device.');
      loadAll();
    } catch (e: any) { setError(e?.response?.data?.error?.message || e?.message); }
  }

  if (!currentField) {
    return <EmptyState title="No field selected" message="Select a field to manage its devices, deployments and sensor telemetry." />;
  }

  const deployedIds = new Set((deployments as any[]).map((d) => d.device_id));

  return (
    <div className="p-6 max-w-6xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-slate-200">{t('nav.sensors')}</h1>
          <p className="text-xs text-slate-400 mt-0.5">Field: <span className="text-slate-200">{currentField.name}</span></p>
        </div>
        <button onClick={() => loadAll()} disabled={busy} className="px-3 py-1.5 rounded-lg text-sm bg-sky-600/30 text-sky-200 border border-sky-500/50 hover:bg-sky-600/40 disabled:opacity-50">
          {busy ? 'Loading…' : '⟳ Refresh'}
        </button>
      </div>

      <InfoNote>
        IoT architecture: ESP32/Arduino → MQTT 5 (or HTTPS) → device-key auth → validation/dedup → raw telemetry preserved → observation + OBSERVED evidence.
        Registration below issues a device key (shown once). No telemetry is ever fabricated — devices report real readings. Offline edge buffers replay via the sync endpoint and are deduplicated by message id.
      </InfoNote>

      {error && <ErrorState title="Sensor request failed" message={error} />}

      {health && (
        <Panel title={`Hardware health — ${health.device_count} device(s), ${health.deployed_count} deployed`} right={lastRefresh ? <span className="text-[11px] text-slate-500">updated {lastRefresh.toLocaleTimeString()}</span> : undefined}>
          {health.devices?.length ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
              {health.devices.map((d: any) => (
                <div key={d.device_id} className="border border-slate-700 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-100 truncate">{d.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {d.deployed ? 'deployed' : 'not deployed'}
                      {d.battery != null ? ` · battery ${d.battery}%` : ''}
                      {d.observation_age_s != null ? ` · last reading ${Math.round(d.observation_age_s / 60)} min ago` : ' · no readings yet'}
                    </p>
                  </div>
                  <StateChip state={d.derived_state} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No devices registered" message="Derived device state (ONLINE/STALE/OFFLINE) appears here once hardware reports heartbeats or telemetry." />
          )}
        </Panel>
      )}
      {flash && <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">{flash}</div>}

      {apiKey && (
        <div className="border border-amber-500/40 bg-amber-500/10 rounded-xl p-4">
          <p className="text-xs font-semibold text-amber-200 mb-1">Device key (shown once — store it on the device)</p>
          <code className="text-[11px] font-mono break-all text-amber-100">{apiKey}</code>
          <p className="text-[11px] text-amber-200/70 mt-1">Send as <code className="font-mono">x-device-key</code> header to <code className="font-mono">POST /api/devices/:id/heartbeat</code> and <code className="font-mono">POST /api/devices/:id/telemetry</code>.</p>
        </div>
      )}

      <div className="grid md:grid-cols-2 gap-4">
        <Panel title="Register a device">
          <div className="space-y-2">
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Device name (e.g. Probe-01)" className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500" />
            <div className="flex gap-2">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100">
                {['soil_moisture_probe', 'weather_station', 'water_level', 'irrigation_controller'].map((ty) => <option key={ty} value={ty}>{ty}</option>)}
              </select>
              <input value={form.serial_number} onChange={(e) => setForm({ ...form, serial_number: e.target.value })} placeholder="Serial" className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500" />
            </div>
            <button onClick={registerDevice} className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-500">Register device</button>
          </div>
        </Panel>

        <Panel title="Attach a sensor">
          <div className="space-y-2">
            <select value={sForm.device_id} onChange={(e) => setSForm({ ...sForm, device_id: e.target.value })} className="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100">
              <option value="">Select device…</option>
              {devices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.status})</option>)}
            </select>
            <div className="flex gap-2">
              <input value={sForm.sensor_type} onChange={(e) => setSForm({ ...sForm, sensor_type: e.target.value })} placeholder="sensor_type (e.g. soil_moisture)" className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100" />
              <input value={sForm.unit} onChange={(e) => setSForm({ ...sForm, unit: e.target.value })} placeholder="unit" className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100" />
            </div>
            <button onClick={addSensor} className="px-4 py-2 rounded-lg text-sm font-semibold bg-sky-600 text-white hover:bg-sky-500">Add sensor</button>
          </div>
        </Panel>
      </div>

      <Panel title={`Devices (${devices.length})`}>
        {devices.length ? (
          <div className="space-y-2">
            {devices.map((d) => (
              <div key={d.id} className="flex items-center justify-between gap-3 border border-slate-700 rounded-lg px-3 py-2">
                <div className="text-xs">
                  <p className="font-semibold text-slate-100">{d.name} <span className="text-slate-500 font-normal">· {d.type}</span></p>
                  <p className="text-slate-400 mt-0.5">{d.id}</p>
                  {d.last_seen_at && <p className="text-slate-500 mt-0.5">Last seen {new Date(d.last_seen_at).toLocaleString()}{d.battery !== null && d.battery !== undefined ? ` · battery ${d.battery}%` : ''}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StateChip state={d.derived_state || d.status} />
                  {!deployedIds.has(d.id) && (
                    <button onClick={() => deploy(d.id)} className="text-[11px] px-2.5 py-1 rounded bg-emerald-600/30 text-emerald-200 border border-emerald-500/40 hover:bg-emerald-600/40">Deploy to field</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No devices" message="Register the field hardware above. Devices authenticate with a per-device key." />}
      </Panel>

      {deployments.length > 0 && (
        <Panel title={`Deployments (${deployments.length})`}>
          <GenericTable rows={deployments as Record<string, unknown>[]} />
        </Panel>
      )}

      <Panel title={`Sensors (${sensors.length})`}>
        {sensors.length ? (
          <GenericTable rows={sensors.map((s) => ({ id: s.id.slice(0, 8), sensor_type: s.sensor_type, unit: s.unit, calibration: s.calibration?.state || 'NOT_CALIBRATED', status: s.status })) as Record<string, unknown>[]} />
        ) : <EmptyState title="No sensors registered" message="Attach a sensor to a device; telemetry ingested via MQTT/HTTPS becomes observations automatically." />}
      </Panel>

      <Panel title="Latest observations by sensor type">
        {latest.length ? (
          <GenericTable rows={latest.map((o) => ({ sensor_type: o.sensor_type, value: o.value, unit: o.unit, quality: o.quality, timestamp: new Date(o.timestamp).toLocaleString(), depth_m: o.depth_meters })) as Record<string, unknown>[]} />
        ) : <EmptyState title="No telemetry received" message="Observations arrive from real devices. Post readings to /api/devices/:id/telemetry with the device key, or ingest via MQTT. Values render with their real observation timestamps — never as a fabricated 'live' value." />}
      </Panel>
    </div>
  );
}
