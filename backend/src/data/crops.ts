/**
 * Crop repository — crop cycles and recorded states (UNKNOWN until observed).
 */
import { dbAll, dbGet, dbRun } from './db';
import { generateId } from '../database/sqlite';

export interface CropCycleRow {
  id: string; field_id: string; crop_type: string; variety?: string | null; season?: string | null;
  sowing_date?: string | null; expected_harvest_date?: string | null; actual_harvest_date?: string | null;
  status: string; created_at: string; updated_at: string;
}

export async function createCropCycle(input: {
  fieldId: string; cropType: string; variety?: string; season?: string; sowingDate?: string; expectedHarvestDate?: string;
}): Promise<CropCycleRow> {
  const id = generateId();
  await dbRun(
    `INSERT INTO crop_cycles (id, field_id, crop_type, variety, season, sowing_date, expected_harvest_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.fieldId, input.cropType, input.variety || null, input.season || null,
     input.sowingDate || null, input.expectedHarvestDate || null]
  );
  return (await dbGet(`SELECT * FROM crop_cycles WHERE id = $1`, [id])) as CropCycleRow;
}

export async function listCropCycles(fieldId: string): Promise<CropCycleRow[]> {
  return (await dbAll(`SELECT * FROM crop_cycles WHERE field_id = $1 ORDER BY created_at DESC`, [fieldId])) as CropCycleRow[];
}

export async function latestCropCycle(fieldId: string): Promise<CropCycleRow | null> {
  return (await dbGet(`SELECT * FROM crop_cycles WHERE field_id = $1 ORDER BY created_at DESC LIMIT 1`, [fieldId])) as CropCycleRow | null;
}

export async function recordCropState(input: { cycleId: string; growthStage?: string; healthIndex?: number; observations?: Record<string, unknown>; state?: string }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO crop_states (id, crop_cycle_id, growth_stage, health_index, observations, state)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.cycleId, input.growthStage || null, input.healthIndex ?? null, input.observations || {}, input.state || 'UNKNOWN']
  );
  return dbGet(`SELECT * FROM crop_states WHERE id = $1`, [id]);
}

export async function listCropStates(cycleId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM crop_states WHERE crop_cycle_id = $1 ORDER BY recorded_at DESC`, [cycleId]);
}
