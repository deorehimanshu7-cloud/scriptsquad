import { Router, Response } from 'express';
import { authenticate } from '../middleware/auth';
import { fieldIsolation, FieldIsolatedRequest } from '../middleware/field-isolation';
import {
  createSimulation, listSimulations, getSimulation, updateSimulation,
} from '../data/intel';
import { latestWorldModelSnapshot } from '../data/system';
import { getField } from '../data/fields';
import { emitEvent } from '../services/events';

const router = Router({ mergeParams: true });

router.post('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const { name, scenario, assumptions } = req.body || {};
    if (!scenario || typeof scenario !== 'object') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION', message: 'scenario object is required' } });
    }
    const sim = await createSimulation({
      fieldId: req.fieldContext!.fieldId, userId: req.user!.id,
      name: name || 'Unnamed scenario',
      scenario,
      assumptions: Array.isArray(assumptions) ? assumptions : ['Scenario outputs are SIMULATED and never mutate the live world model.'],
    });
    res.status(201).json({ success: true, data: sim });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const rows = await listSimulations(req.fieldContext!.fieldId, req.user!.id);
  res.json({ success: true, data: rows, total: rows.length });
});

router.post('/:simulationId/run', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  try {
    const sim = await getSimulation(req.params.simulationId, req.fieldContext!.fieldId, req.user!.id);
    if (!sim) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Simulation not found' } });
    await updateSimulation(sim.id, { status: 'RUNNING', executedAt: new Date().toISOString() });

    const field = await getField(req.fieldContext!.fieldId, req.user!.id);
    const snapshot = await latestWorldModelSnapshot(req.fieldContext!.fieldId);
    const baseline = snapshot?.world_model || null;
    const scenario = sim.scenario || {};
    const assumptions = sim.assumptions || [];

    // ── SIMULATED scenario evaluation (isolated — never mutates live WM) ──
    const scenarioType = (scenario.type as string) || (scenario.scenario_type as string) || 'custom';
    const irrigationDelta = Number(scenario.irrigation_mm ?? scenario.rain_delta_mm ?? 0) || 0;
    const tempDelta = Number(scenario.temperature_delta_c ?? 0) || 0;

    const simWeather = baseline?.state?.weather ? {
      state: 'SIMULATED',
      data: {
        ...(baseline.state.weather.data || {}),
        scenario_note: `Weather adjusted by scenario "${scenarioType}" (temperature_delta ${tempDelta}°C, water_delta ${irrigationDelta} mm).`,
        water_adjustment_mm: irrigationDelta,
        temperature_adjustment_c: tempDelta,
      },
      baseline_state: baseline.state.weather.state,
    } : { state: 'SIMULATED', data: { note: 'No weather baseline available — scenario applied to an UNKNOWN baseline.' }, baseline_state: 'UNKNOWN' };

    const simCrop = baseline?.state?.crop ? {
      state: 'SIMULATED',
      data: {
        ...(baseline.state.crop.data || {}),
        scenario_response: irrigationDelta > 0
          ? `Irrigation (+${irrigationDelta} mm) simulated — modelled moisture-limited stress reduced (MODELLED response).`
          : `Scenario "${scenarioType}" — modelled crop response pending validation.`,
      },
    } : { state: 'SIMULATED', data: { note: 'No crop baseline.' } };

    const result = {
      status: 'COMPLETED',
      label: 'SIMULATED',
      scenario_type: scenarioType,
      executed_at: new Date().toISOString(),
      baseline_world_model_version: baseline?.version || null,
      assumptions,
      outputs: {
        weather: simWeather,
        crop: simCrop,
        note: 'All scenario outputs are SIMULATED — they never enter the live world model, evidence store, or farm memory.',
      },
    };
    await updateSimulation(sim.id, { status: 'COMPLETED', result, executedAt: new Date().toISOString() });
    await emitEvent('SIMULATION_COMPLETED', { simulation_id: sim.id, scenario_type: scenarioType }, { fieldId: field?.id, userId: req.user!.id }).catch(() => {});
    res.json({ success: true, data: { id: sim.id, status: 'COMPLETED', result } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'INTERNAL', message: error.message } });
  }
});

router.get('/:simulationId/compare', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const sim = await getSimulation(req.params.simulationId, req.fieldContext!.fieldId, req.user!.id);
  if (!sim) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Simulation not found' } });
  const snapshot = await latestWorldModelSnapshot(req.fieldContext!.fieldId);
  res.json({
    success: true,
    data: {
      simulation_id: sim.id,
      label: 'SIMULATED',
      live_world_model_version: snapshot?.version || null,
      scenario: sim.scenario,
      simulated_outputs: sim.result || null,
      comparison: {
        note: 'Side-by-side comparison of the live world model and the SIMULATED scenario. Simulated state never mutates live state.',
        live_weather_state: snapshot?.world_model?.state?.weather?.state || 'UNKNOWN',
        live_satellite_state: snapshot?.world_model?.state?.satellite?.state || 'UNKNOWN',
      },
    },
  });
});

router.get('/:simulationId', authenticate, fieldIsolation, async (req: FieldIsolatedRequest, res: Response) => {
  const sim = await getSimulation(req.params.simulationId, req.fieldContext!.fieldId, req.user!.id);
  if (!sim) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Simulation not found' } });
  res.json({ success: true, data: sim });
});

export default router;
