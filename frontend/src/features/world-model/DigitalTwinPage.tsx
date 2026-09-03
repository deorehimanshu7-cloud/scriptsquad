import React, { Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useFieldStore } from '@/lib/state/field';
import { api } from '@/lib/api/client';
import { DigitalTwinScene } from '@/features/digital-twin/components/DigitalTwinScene';

export default function DigitalTwinPage() {
  const { t } = useTranslation();
  const { currentField } = useFieldStore();
  const [worldModel, setWorldModel] = useState<any>(null);
  const [hardware, setHardware] = useState<any>({ devices: [], deployments: [], latest: [] });
  const [imagery, setImagery] = useState<'LOADING' | 'AVAILABLE' | 'UNAVAILABLE'>('LOADING');
  const [explodeFactor, setExplodeFactor] = useState(0);
  const [viewRequest, setViewRequest] = useState<{ target: 'field' | 'world'; ts: number } | null>(null);
  const [layers, setLayers] = useState({
    terrain: true, crop: true, sensors: true, risk: true,
    anomaly: true, evidence: true, water: false, soil: false, rootZone: false,
  });

  // Real hardware markers only — never decorative. Location comes from the
  // deployment/device location or the most recent observation geometry.
  const sensorMarkers = useMemo(() => {
    const out: { id: string; type: string; lat: number; lng: number; status: 'active' | 'inactive' | 'error' }[] = [];
    const { deployments, devices, latest } = hardware;
    const latestByDevice = new Map<string, any>();
    for (const o of latest || []) if (!latestByDevice.has(o.device_id)) latestByDevice.set(o.device_id, o);
    for (const d of devices || []) {
      const point: number[] | null =
        d.location?.coordinates || (latestByDevice.get(d.id)?.geometry?.coordinates || null) || null;
      if (!point) continue; // no genuine position → no marker
      out.push({
        id: d.id, type: d.type,
        lat: point[1], lng: point[0],
        status: d.derived_state === 'ONLINE' ? 'active'
          : (d.derived_state === 'MAINTENANCE' || d.derived_state === 'ERROR') ? 'error' : 'inactive',
      });
    }
    return out;
  }, [hardware]);

  const loadFieldData = useCallback((fieldId: string) => {
    // FIELD ISOLATION: every switch starts from an empty slate — stale devices,
    // observations, World Model and imagery status never bleed through.
    setWorldModel(null);
    setHardware({ devices: [], deployments: [], latest: [] });
    setImagery('LOADING');
    api.get<{ success: boolean; data: any }>('/fields/' + fieldId + '/world-model')
      .then(r => { if (r.success) setWorldModel(r.data); })
      .catch(() => {});
    api.get<any>(`/fields/${fieldId}/devices`).then((r) => {
      if (r.success) setHardware({ devices: r.data.devices || [], deployments: r.data.deployments || [], latest: [] });
    }).catch(() => {});
    api.get<any>(`/fields/${fieldId}/observations/latest`).then((r) => {
      if (r.success) setHardware((h: any) => ({ ...h, latest: r.data || [] }));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (currentField) loadFieldData(currentField.id);
    else setHardware({ devices: [], deployments: [], latest: [] });
  }, [currentField, loadFieldData]);

  // REAL-TIME: live hardware observations refresh the Twin while it is open.
  useEffect(() => {
    if (!currentField) return;
    const es = new EventSource('/api/system/events/stream');
    const onEvent = (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data);
        if (!ev || ev.field_id !== currentField.id) return;
        if (['OBSERVATION_RECEIVED', 'SENSOR_CONNECTED', 'WORLD_MODEL_UPDATED'].includes(ev.type)) {
          loadFieldData(currentField.id);
        }
      } catch { /* ignore malformed frames */ }
    };
    es.addEventListener('message', onEvent);
    return () => es.close();
  }, [currentField?.id, loadFieldData]);

  if (!currentField) return (
    <div className="flex flex-col items-center justify-center h-full">
      <div className="text-6xl mb-4">🎯</div>
      <h2 className="text-xl font-semibold text-slate-200 mb-2">{t('digital_twin.title')}</h2>
      <p className="text-slate-400">{t('digital_twin.no_field')}</p>
    </div>
  );

  const toggleLayer = (key: keyof typeof layers) => setLayers(prev => ({ ...prev, [key]: !prev[key] }));

  const layerControls = [
    { key: 'terrain' as const, color: 'bg-amber-500', label: 'Terrain (imagery + relief)' },
    { key: 'crop' as const, color: 'bg-green-400', label: 'Crop (Modelled)' },
    { key: 'soil' as const, color: 'bg-amber-700', label: 'Soil cutaway (Modelled)' },
    { key: 'rootZone' as const, color: 'bg-orange-800', label: 'Root zone (Modelled)' },
    { key: 'water' as const, color: 'bg-blue-500', label: 'Water table (visual)' },
    { key: 'sensors' as const, color: 'bg-cyan-500', label: 'Sensors (OBSERVED only)' },
    { key: 'evidence' as const, color: 'bg-purple-500', label: 'Evidence' },
    { key: 'anomaly' as const, color: 'bg-yellow-500', label: 'Anomaly' },
    { key: 'risk' as const, color: 'bg-red-500', label: 'Risk' },
  ];

  return (
    <div className="flex h-full">
      <div className="flex-1 relative bg-slate-900">
        <Suspense fallback={
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-slate-400 text-sm">Loading 3D Digital Twin...</p>
            </div>
          </div>
        }>
          <DigitalTwinScene
            geometry={currentField.geometry}
            centroid={currentField.centroid}
            layers={layers}
            explodeFactor={explodeFactor}
            sensors={sensorMarkers}
            onImageryStatus={setImagery}
            viewRequest={viewRequest}
          />
        </Suspense>

        {/* Layer Controls */}
        <div className="absolute top-4 left-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-4 border border-slate-700">
          <h4 className="text-sm font-semibold text-slate-200 mb-3">{t('digital_twin.layers')}</h4>
          <div className="space-y-2">
            {layerControls.map(l => (
              <label key={l.key} className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={layers[l.key]} onChange={() => toggleLayer(l.key)} className="rounded" />
                <span className={`w-2 h-2 rounded-full ${l.color}`} />
                <span className="text-xs text-slate-300">{l.label}</span>
              </label>
            ))}
          </div>
        </div>

        {/* View + Explode Controls */}
        <div className="absolute bottom-4 left-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-4 border border-slate-700 w-72">
          <div className="flex gap-2 mb-3">
            <button onClick={() => setViewRequest({ target: 'field', ts: Date.now() })}
              className="flex-1 text-xs px-2 py-1.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white font-medium">Fit Field</button>
            <button onClick={() => setViewRequest({ target: 'world', ts: Date.now() })}
              className="flex-1 text-xs px-2 py-1.5 rounded-md bg-slate-600 hover:bg-slate-500 text-white font-medium">Fit World</button>
            <button onClick={() => setExplodeFactor(0)}
              className="flex-1 text-xs px-2 py-1.5 rounded-md bg-slate-600 hover:bg-slate-500 text-white font-medium">Reset</button>
          </div>
          <label className="text-sm font-semibold text-slate-200 block mb-2">{t('digital_twin.explode')}</label>
          <input type="range" min="0" max="100" value={explodeFactor * 100}
            onChange={e => setExplodeFactor(parseInt(e.target.value) / 100)} className="w-full" />
          <div className="flex justify-between text-xs text-slate-500 mt-1"><span>Flat</span><span>Exploded</span></div>
          <p className="text-[9px] text-slate-500 mt-2 leading-snug">Explode is a visual Z offset only — all layers keep their geographic X/Y position. Soil / root-zone / water slabs are a MODELLED cutaway, never claimed as measured geometry.</p>
        </div>

        {/* Truth States Legend */}
        <div className="absolute bottom-4 right-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-4 border border-slate-700">
          <h4 className="text-sm font-semibold text-slate-200 mb-2">Truth States</h4>
          <div className="space-y-1">
            {[{ s: 'OBSERVED', c: 'bg-green-500' }, { s: 'MODELLED', c: 'bg-indigo-500' },
              { s: 'ESTIMATED', c: 'bg-yellow-500' }, { s: 'SIMULATED', c: 'bg-purple-500' },
              { s: 'UNKNOWN', c: 'bg-gray-500' }].map(x => (
              <div key={x.s} className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${x.c}`} />
                <span className="text-xs text-slate-400">{x.s}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Field Info */}
        <div className="absolute top-4 right-4 bg-slate-800/90 backdrop-blur-sm rounded-lg p-3 border border-slate-700 w-56">
          <h3 className="text-sm font-semibold text-slate-200">{currentField.name}</h3>
          <p className="text-xs text-slate-400">{typeof currentField.area_hectares === 'number' && isFinite(currentField.area_hectares) ? currentField.area_hectares.toFixed(2) + ' ha' : 'AREA UNKNOWN'}</p>
          <p className="text-[10px] text-slate-500 mt-1.5">
            Hardware: {hardware.devices.length} device(s), {sensorMarkers.length} with a genuine geographic position shown in 3D.
          </p>
          <p className="text-[10px] text-slate-500">No fake hardware markers are ever rendered.</p>
          <p className="text-[10px] mt-1">
            {imagery === 'AVAILABLE'
              ? <span className="text-emerald-600 font-medium">Imagery: real Esri World Imagery tile (OBSERVED)</span>
              : imagery === 'LOADING'
                ? <span className="text-slate-500">Imagery: loading real tile…</span>
                : <span className="text-amber-600 font-medium">Imagery: UNAVAILABLE — relief surface only (network/offline)</span>}
          </p>
        </div>
      </div>
    </div>
  );
}
