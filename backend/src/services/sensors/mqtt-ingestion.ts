/**
 * AGRIFUR2 MQTT Sensor Ingestion Pipeline
 *
 * Architecture: SENSOR → ESP32 → MQTT 5 → BROKER → THIS SERVICE → VALIDATION → NORMALIZATION → OBSERVATION
 * Topic strategy: agrifur2/{farm_id}/{field_id}/{device_id}/{sensor_type}
 */

import { v4 as uuidv4 } from 'uuid';

export interface SensorReading {
  device_id: string;
  sensor_type: string;
  value: number;
  unit: string;
  timestamp: string;
  battery?: number;
  firmware_version?: string;
  raw?: Record<string, any>;
}

export interface IngestedObservation {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  device_id: string;
  sensor_id: string;
  sensor_type: string;
  timestamp: Date;
  value: number;
  unit: string;
  quality: 'VALID' | 'OUT_OF_RANGE' | 'STALE' | 'DUPLICATE' | 'INVALID';
  calibration_version: number;
  firmware_version?: string;
  raw_data: Record<string, any>;
  ingestion_metadata: {
    mqtt_topic: string;
    mqtt_qos: number;
    ingested_at: Date;
    pipeline_version: string;
  };
}

const SENSOR_RANGES: Record<string, { min: number; max: number; unit: string }> = {
  soil_moisture: { min: 0, max: 100, unit: '%' },
  soil_temperature: { min: -20, max: 60, unit: '°C' },
  air_temperature: { min: -40, max: 60, unit: '°C' },
  humidity: { min: 0, max: 100, unit: '%' },
  water_level: { min: 0, max: 5000, unit: 'mm' },
  water_flow: { min: 0, max: 1000, unit: 'L/min' },
  battery: { min: 0, max: 100, unit: '%' },
  light_intensity: { min: 0, max: 200000, unit: 'lux' },
};

const dedupCache: Map<string, Date> = new Map();

export function parseTopic(topic: string) {
  const parts = topic.split('/');
  if (parts.length < 5 || parts[0] !== 'agrifur2') return null;
  return { farm_id: parts[1], field_id: parts[2], device_id: parts[3], sensor_type: parts[4] };
}

export function validateReading(reading: SensorReading) {
  if (reading.value === null || reading.value === undefined || isNaN(reading.value)) {
    return { valid: false, quality: 'INVALID' as const, reason: 'Not a number' };
  }
  const range = SENSOR_RANGES[reading.sensor_type];
  if (range && (reading.value < range.min || reading.value > range.max)) {
    return { valid: false, quality: 'OUT_OF_RANGE' as const, reason: `Outside [${range.min},${range.max}]` };
  }
  return { valid: true, quality: 'VALID' as const };
}

export function processSensorMessage(topic: string, payload: Buffer | string, userId: string): IngestedObservation | null {
  const parts = parseTopic(topic);
  if (!parts) return null;
  let reading: SensorReading;
  try {
    reading = JSON.parse(typeof payload === 'string' ? payload : payload.toString('utf-8'));
  } catch { return null; }
  const key = `${reading.device_id}:${reading.timestamp}`;
  if (dedupCache.has(key)) return null;
  dedupCache.set(key, new Date());
  const validation = validateReading(reading);
  const range = SENSOR_RANGES[reading.sensor_type];
  return {
    id: uuidv4(), user_id: userId, farm_id: parts.farm_id, field_id: parts.field_id,
    device_id: reading.device_id, sensor_id: `${reading.device_id}:${reading.sensor_type}`,
    sensor_type: reading.sensor_type, timestamp: new Date(reading.timestamp),
    value: reading.value, unit: reading.unit || range?.unit || '',
    quality: validation.quality, calibration_version: 1,
    firmware_version: reading.firmware_version, raw_data: reading.raw || {},
    ingestion_metadata: { mqtt_topic: topic, mqtt_qos: 1, ingested_at: new Date(), pipeline_version: '1.0.0' },
  };
}

export function buildTopic(farmId: string, fieldId: string, deviceId: string, sensorType: string): string {
  return `agrifur2/${farmId}/${fieldId}/${deviceId}/${sensorType}`;
}
