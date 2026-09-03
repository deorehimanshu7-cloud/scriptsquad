/**
 * AGRIFUR2 AI Tool Definitions
 *
 * These tools are available to the LLM for querying the World Model.
 * The LLM MUST call these tools to gather evidence before answering.
 * It must never invent field facts — if tools return no data, it says so.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'getWorldModel',
    description: 'Get the current World Model state for a field, including crop, soil, water, terrain, sensors, weather, satellite, anomalies, risks, and investigations.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'getEvidence',
    description: 'Get all evidence for a field, with optional source filter. Evidence includes satellite observations, sensor readings, weather data, farmer observations, etc.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string', description: 'The field ID' },
        source: { type: 'string', description: 'Filter by source: EARTH_OBSERVATION, PHYSICAL_HARDWARE, ENVIRONMENT, WATER, AGRICULTURE, FARMER_INPUT, HISTORY' },
      },
      required: ['fieldId'],
    },
  },
  {
    name: 'getWeather',
    description: 'Get current weather and forecast for a field location from Open-Meteo.',
    parameters: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: 'Latitude of field centroid' },
        lng: { type: 'number', description: 'Longitude of field centroid' },
      },
      required: ['lat', 'lng'],
    },
  },
  {
    name: 'getSatellite',
    description: 'Get latest available satellite observations for a field from Copernicus.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string', description: 'The field ID' },
      },
      required: ['fieldId'],
    },
  },
  {
    name: 'getSensors',
    description: 'Get real physical sensor observations for a field (device telemetry). Each reading is OBSERVED with its actual timestamp.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'getDeviceStatus',
    description: 'Get deployed device states (ONLINE/OFFLINE/STALE/MAINTENANCE) derived from real heartbeats, plus per-sensor calibration state.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'getSensorHistory',
    description: 'Get recent observation history for one sensor type on a field.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string', description: 'The field ID' },
        sensor_type: { type: 'string', description: 'e.g. soil_moisture, soil_temperature, water_level' },
      },
      required: ['fieldId', 'sensor_type'],
    },
  },
  {
    name: 'getCalibration',
    description: 'Get calibration records/state (CALIBRATED, CALIBRATION_EXPIRED, NOT_CALIBRATED) for sensors on a field.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string', description: 'The field ID' },
        sensor_type: { type: 'string', description: 'Optional sensor type filter' },
      },
      required: ['fieldId'],
    },
  },
  {
    name: 'getAnomalies',
    description: 'Get detected anomalies for a field.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'getRisks',
    description: 'Get active risks for a field.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'getContradictions',
    description: 'Get contradictions between evidence sources for a field.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
  {
    name: 'createInvestigation',
    description: 'Create a new investigation when the AI detects an issue that needs deeper analysis.',
    parameters: {
      type: 'object',
      properties: {
        fieldId: { type: 'string', description: 'The field ID' },
        title: { type: 'string', description: 'Investigation title' },
        description: { type: 'string', description: 'What triggered this investigation' },
      },
      required: ['fieldId', 'title'],
    },
  },
  {
    name: 'suggestNextObservation',
    description: 'Suggest the next best observation to reduce uncertainty about a field.',
    parameters: {
      type: 'object',
      properties: { fieldId: { type: 'string', description: 'The field ID' } },
      required: ['fieldId'],
    },
  },
];
