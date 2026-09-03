/**
 * AGRIFUR2 AI engine.
 *
 * The LLM is NEVER the source of field truth. Both paths (LLM and local
 * engine) first gather REAL field context through repository-backed tools, and
 * both are constrained by the same safety rules: never invent measurements,
 * products, confidence or state; when evidence is insufficient say exactly
 * that; explain conflicts with supporting/conflicting/missing views.
 */
import axios from 'axios';
import { getField } from '../../data/fields';
import { executeTool, ToolResult } from './tool-executor';

export interface AiResponse {
  content: string;
  toolCalls: { name: string; args: Record<string, any>; result?: ToolResult }[];
  model: string;
  evidenceRefs: string[];
  providerStatus: 'AVAILABLE' | 'AUTH_REQUIRED';
}

const SAFETY_PROMPT = [
  'You are AGRIFUR2 AI, an agricultural intelligence assistant operating on REAL field data.',
  'ABSOLUTE RULES:',
  '1. Never invent field measurements, satellite products, soil/water values, anomalies, risks or confidence numbers.',
  '2. Only report values that appear in tool results; otherwise state: "The requested field data is currently unavailable."',
  '3. Respect evidence states: OBSERVED vs ESTIMATED vs MODELLED vs REANALYSIS vs MODEL_DERIVED vs SIMULATED vs UNKNOWN.',
  '4. If tool results conflict, list supporting, conflicting and missing evidence instead of choosing a winner.',
  '5. When data is missing, suggest what should be observed next (use suggestNextObservation).',
  '6. For irrigation/chemical/harvest decisions recommend expert consultation.',
  '7. Answer in the requested language.',
].join('\n');

const TOOL_CHOICES: Record<string, string[]> = {
  getField: ['getField', 'getWorldModel', 'getEvidence', 'getFarmerObservations'],
  weather: ['getWeather'],
  rain: ['getWeather'],
  satellite: ['getSatellite'],
  ndvi: ['getSatellite'],
  sensor: ['getSensors'],
  moisture: ['getSensors'],
  humidity: ['getSensors'],
  battery: ['getDeviceStatus'],
  device: ['getDeviceStatus'],
  calibrat: ['getCalibration', 'getSensors'],
  sampling: ['getDeviceStatus'],
  soil: ['getSoil'],
  ph: ['getSoil'],
  ec: ['getSoil'],
  water: ['getWater'],
  ground: ['getWater'],
  terrain: ['getTerrain'],
  elevation: ['getTerrain'],
  risk: ['getRisks', 'getAnomalies'],
  anomal: ['getAnomalies', 'getRisks'],
  contradict: ['getContradictions'],
  uncertain: ['getUncertainty'],
  investigate: ['getInvestigations'],
  history: ['getHistory'],
  memory: ['getFarmMemory'],
  next: ['suggestNextObservation'],
  observe: ['suggestNextObservation'],
  should: ['suggestNextObservation'],
  crop: ['getWorldModel', 'getSoil'],
};

export async function processAssistantMessage(input: { fieldId: string; userId: string; message: string; language?: string }): Promise<AiResponse> {
  const { fieldId, userId, message, language = 'en' } = input;
  const field = await getField(fieldId, userId);
  const toolCalls: AiResponse['toolCalls'] = [];
  const evidenceRefs: string[] = [];

  // 1. Always ground with core tools
  const core = ['getField', 'getWorldModel', 'getEvidence'];
  const wanted = new Set<string>(core);
  const lower = message.toLowerCase();
  for (const [keyword, tools] of Object.entries(TOOL_CHOICES)) {
    if (lower.includes(keyword)) tools.forEach((t) => wanted.add(t));
  }
  if (lower.length < 3) wanted.add('suggestNextObservation');

  for (const tool of wanted) {
    const result = await executeTool(tool, { fieldId }, userId);
    toolCalls.push({ name: tool, args: { fieldId }, result });
    if (tool === 'getEvidence' && result.ok && Array.isArray(result.data)) {
      for (const e of (result.data as any[]).slice(0, 12)) if (e.id) evidenceRefs.push(e.id);
    }
  }

  const hasLlm = !!process.env.AI_API_KEY;
  if (!field) {
    return { content: 'The selected field is not accessible. Please reselect a field.', toolCalls, model: hasLlm ? process.env.AI_MODEL || 'gpt-4o-mini' : 'local-grounded-engine', evidenceRefs, providerStatus: hasLlm ? 'AVAILABLE' : 'AUTH_REQUIRED' };
  }

  if (hasLlm) {
    const content = await callLlmWithTools(message, language, fieldId, userId, toolCalls);
    return { content, toolCalls, model: process.env.AI_MODEL || 'gpt-4o-mini', evidenceRefs, providerStatus: 'AVAILABLE' };
  }

  const content = composeGroundedAnswer(message, toolCalls);
  return { content, toolCalls, model: 'local-grounded-engine', evidenceRefs, providerStatus: 'AUTH_REQUIRED' };
}

// ── Optional LLM path (OpenAI-compatible) ───────────────────────────────────
async function callLlmWithTools(message: string, language: string, fieldId: string, userId: string, prior: AiResponse['toolCalls']): Promise<string> {
  const apiKey = process.env.AI_API_KEY!;
  const apiBase = process.env.AI_API_BASE || 'https://api.openai.com/v1';
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const toolContext = prior.map((t) => ({ tool: t.name, result: t.result }));
  const messages: any[] = [
    { role: 'system', content: `${SAFETY_PROMPT}\nField: ${fieldId}\nLanguage: ${language}\n\nREAL FIELD CONTEXT RETRIEVED THROUGH TOOLS (use ONLY these values; never invent others):\n${JSON.stringify(toolContext).slice(0, 14000)}` },
    { role: 'user', content: message },
  ];
  try {
    for (let i = 0; i < 3; i++) {
      const resp = await axios.post(`${apiBase}/chat/completions`, {
        model,
        messages,
        temperature: 0.2,
        max_tokens: 1200,
      }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 30000 });
      const content = resp.data?.choices?.[0]?.message?.content;
      if (content) return content;
      return 'No response generated by the model.';
    }
    return 'Model conversation limit reached.';
  } catch (e: any) {
    // fall back to the grounded local engine — never invent data
    return composeGroundedAnswer(message, prior);
  }
}

// ── Local grounded engine (never invents; English unless LLM configured) ────
function findTool(toolCalls: AiResponse['toolCalls'], name: string): ToolResult | undefined {
  return toolCalls.find((t) => t.name === name)?.result;
}

function composeGroundedAnswer(message: string, toolCalls: AiResponse['toolCalls']): string {
  const wm = findTool(toolCalls, 'getWorldModel');
  const evidence = findTool(toolCalls, 'getEvidence');
  const weather = findTool(toolCalls, 'getWeather');
  const sat = findTool(toolCalls, 'getSatellite');
  const sensors = findTool(toolCalls, 'getSensors');
  const deviceStatus = findTool(toolCalls, 'getDeviceStatus');
  const soil = findTool(toolCalls, 'getSoil');
  const water = findTool(toolCalls, 'getWater');
  const risks = findTool(toolCalls, 'getRisks');
  const anomalies = findTool(toolCalls, 'getAnomalies');
  const contradictions = findTool(toolCalls, 'getContradictions');
  const nextObs = findTool(toolCalls, 'suggestNextObservation');

  const lines: string[] = [];
  lines.push(`Field analysis from real evidence${wm?.ok ? '' : ' (world model unavailable)'}:\n`);

  const state = (wm?.data as any)?.state;
  if (state) {
    const states: Record<string, string> = {};
    for (const [k, v] of Object.entries(state)) {
      if (v && typeof v === 'object' && (v as any).state) states[k] = (v as any).state;
    }
    lines.push(`Known domain states — ${Object.entries(states).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  }

  const coverage = (wm?.data as any)?.coverage;
  if (coverage) {
    lines.push(`Evidence coverage: ${coverage.total_evidence} evidence record(s) across ${Object.keys(coverage.by_source || {}).length} source type(s). This is a coverage count — not a confidence percentage.`);
  }

  const evList = evidence?.ok ? (evidence.data as any[]) || [] : [];
  if (evList.length === 0) {
    lines.push('\nNo field evidence is currently available.');
  } else {
    const sources = evList.reduce((m: Record<string, number>, e) => { m[e.source] = (m[e.source] || 0) + 1; return m; }, {});
    lines.push(`Evidence sources: ${Object.entries(sources).map(([s, n]) => `${s} (${n})`).join(', ')}`);
  }

  const w = weather?.data as any;
  if (weather?.ok && w?.current) {
    const cur = w.current;
    const t = cur.temperature_c;
    const h = cur.humidity_pct;
    lines.push(`\nWeather (MODEL_DERIVED, Open-Meteo): ${t != null ? `${t}°C` : 'temp unavailable'}, ${h != null ? `${h}% humidity` : 'humidity unavailable'}${cur.precipitation_mm != null ? `, precipitation ${cur.precipitation_mm} mm` : ''}.`);
  } else if (weather && !weather.ok) {
    lines.push('\nWeather data is currently unavailable.');
  }

  const satData = sat?.ok ? (sat.data as any[]) || [] : [];
  if (sat?.ok && satData.length > 0) {
    const latest = satData[0];
    lines.push(`\nLatest satellite product: ${latest.collection || 'collection unknown'} acquired ${latest.observation_date || 'date unknown'}${latest.cloud_cover != null ? `, cloud ${latest.cloud_cover}%` : ''} (provider: ${latest.provider}).`);
  } else {
    lines.push('\nSatellite: no earth-observation product is stored for this field.');
  }

  const sensorData = sensors?.ok ? (sensors.data as any[]) || [] : [];
  if (sensorData.length > 0) {
    const byType: Record<string, any> = {};
    for (const s of sensorData) if (!byType[s.sensor_type]) byType[s.sensor_type] = s;
    lines.push(`\nSensor readings (OBSERVED): ${Object.entries(byType).map(([t, s]: any) => `${t} ${s.value}${s.unit || ''} (${s.quality}, observed ${new Date(s.timestamp).toLocaleString()})`).join(', ')}`);
  } else if (sensors?.ok) {
    lines.push('\nSensors: no physical observations for this field.');
  }

  const deviceData = (deviceStatus?.ok ? (deviceStatus.data as any[]) || [] : []);
  if (deviceData.length > 0) {
    lines.push(`\nDevices: ${deviceData.map((d: any) => `${d.name} (${d.type}) ${d.derived_state}${d.battery != null ? `, battery ${d.battery}%` : ''}${d.sensors?.length ? `, sensors: ${d.sensors.map((s: any) => `${s.sensor_type}=${s.calibration?.state || 'NOT_CALIBRATED'}`).join(', ')}` : ''}`).join(' | ')}`);
  } else if (deviceStatus?.ok) {
    lines.push('\nDevices: no devices deployed to this field.');
  }

  const soilData = soil?.ok ? (soil.data as any[]) || [] : [];
  const interesting = soilData.filter((s) => ['ph', 'ec', 'organic_carbon', 'clay', 'sand'].includes(s.property));
  if (interesting.length > 0) {
    lines.push(`\nSoil (modelled ESTIMATES): ${interesting.map((s) => `${s.property} ${s.value}${s.unit || ''} (${s.state || 'ESTIMATED'})`).join(', ')}.`);
  } else {
    lines.push('\nSoil: pH/EC not available. No modelled soil estimate is stored — values are never guessed.');
  }

  const waterData = water?.ok ? (water.data as any) : null;
  if (water?.ok && Array.isArray(waterData) && waterData.length === 0) {
    lines.push('\nWater: no water observations available. Groundwater depth is never fabricated.');
  }

  const anomList = anomalies?.ok ? (anomalies.data as any[]) || [] : [];
  if (anomList.length > 0) {
    lines.push(`\nAnomalies detected: ${anomList.map((a) => `${a.type}${a.severity ? ` (${a.severity})` : ''}`).join(', ')}.`);
  }
  const riskList = risks?.ok ? (risks.data as any[]) || [] : [];
  if (riskList.length > 0) {
    lines.push(`Risks active: ${riskList.map((r) => `${r.type} (${r.severity})`).join(', ')}.`);
  }
  const conList = contradictions?.ok ? (contradictions.data as any[]) || [] : [];
  if (conList.length > 0) {
    lines.push(`Contradictions: ${conList.length} unresolved — ${conList.map((c) => c.type).join(', ')}. Supporting and conflicting evidence is surfaced in the investigation workspace; no single source is treated as truth.`);
  }

  const nbo = nextObs?.ok ? (nextObs.data as any[]) || [] : [];
  if (nbo.length > 0) {
    lines.push(`\nNext best observation(s): ${nbo.slice(0, 3).map((n) => `${n.candidate} (${n.priority})`).join(' | ')}`);
  } else {
    lines.push('\nNext best observation: add field data (sensors, satellite, farmer observation) to reduce uncertainty.');
  }

  lines.push('\nNote: numeric confidence is never reported — evidence coverage and data states are shown instead.');
  if (evList.length === 0 || Object.keys(state || {}).length === 0) {
    lines.push('\nThe requested field data is currently unavailable. Connect providers (satellite/weather/sensors) and run an analysis to build evidence.');
  }
  return lines.join('\n');
}
