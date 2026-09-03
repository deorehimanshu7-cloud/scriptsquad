/**
 * Users & Farms repository — single contract over both database modes.
 */
import { dbAll, dbGet, dbRun, GEO, isPostgres } from './db';
import { hashPassword, generateId } from '../database/sqlite';
import type { PublicUser } from '@agrifur2/shared';

// ── Users ───────────────────────────────────────────────────────────────────
export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  language: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export async function createUser(input: { email: string; password: string; name?: string; language?: string }): Promise<PublicUser> {
  const id = generateId();
  const password_hash = hashPassword(input.password);
  await dbRun(
    `INSERT INTO users (id, email, password_hash, name, language) VALUES ($1, $2, $3, $4, $5)`,
    [id, input.email.toLowerCase(), password_hash, input.name || null, input.language || 'en']
  );
  return { id, email: input.email.toLowerCase(), name: input.name, language: input.language || 'en' };
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  return (await dbGet(`SELECT * FROM users WHERE email = $1`, [email.toLowerCase()])) as UserRow | null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  return (await dbGet(`SELECT * FROM users WHERE id = $1`, [id])) as UserRow | null;
}

export async function updateUserLanguage(id: string, language: string): Promise<void> {
  await dbRun(`UPDATE users SET language = $1, updated_at = $2 WHERE id = $3`, [language, new Date().toISOString(), id]);
}

export function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, email: u.email, name: u.name || undefined, language: u.language };
}

// ── Farms ───────────────────────────────────────────────────────────────────
export interface FarmRow {
  id: string;
  user_id: string;
  name: string;
  location: string | null; // GeoJSON Point text (both modes)
  created_at: string;
  updated_at: string;
}

const FARM_SELECT = (f: string) => `SELECT ${f}.id, ${f}.user_id, ${f}.name, ${GEO.toJson(`${f}.location`, 'location')}, ${f}.created_at, ${f}.updated_at FROM farms ${f}`;

export async function listFarms(userId: string): Promise<FarmRow[]> {
  const rows = await dbAll(`${FARM_SELECT('f')} WHERE f.user_id = $1 ORDER BY f.created_at DESC`, [userId]);
  return rows.map(parseFarm);
}

export async function getFarm(farmId: string, userId: string): Promise<FarmRow | null> {
  const row = await dbGet(`${FARM_SELECT('f')} WHERE f.id = $1 AND f.user_id = $2`, [farmId, userId]);
  return row ? parseFarm(row) : null;
}

export async function farmBelongsToUser(farmId: string, userId: string): Promise<boolean> {
  const row = await dbGet(`SELECT 1 AS ok FROM farms WHERE id = $1 AND user_id = $2`, [farmId, userId]);
  return !!row;
}

export async function createFarm(input: { userId: string; name: string; location?: GeoJSON.Point }): Promise<FarmRow> {
  const id = generateId();
  const geo = input.location ? JSON.stringify(input.location) : null;
  await dbRun(
    `INSERT INTO farms (id, user_id, name, location) VALUES ($1, $2, $3, ${GEO.fromJson('$4')})`,
    [id, input.userId, input.name, geo]
  );
  const farm = await getFarm(id, input.userId);
  if (!farm) throw new Error('Farm creation failed');
  return farm;
}

export async function updateFarm(input: { farmId: string; userId: string; name?: string; location?: GeoJSON.Point }): Promise<FarmRow | null> {
  const existing = await getFarm(input.farmId, input.userId);
  if (!existing) return null;
  if (input.name !== undefined) {
    await dbRun(`UPDATE farms SET name = $1, updated_at = $2 WHERE id = $3`, [input.name, new Date().toISOString(), input.farmId]);
  }
  if (input.location) {
    await dbRun(`UPDATE farms SET location = ${GEO.fromJson('$1')}, updated_at = $2 WHERE id = $3`, [JSON.stringify(input.location), new Date().toISOString(), input.farmId]);
  }
  return getFarm(input.farmId, input.userId);
}

export async function deleteFarm(farmId: string, userId: string): Promise<boolean> {
  const res = await dbRun(`DELETE FROM farms WHERE id = $1 AND user_id = $2`, [farmId, userId]);
  return res.changes > 0;
}

function parseFarm(row: any): FarmRow {
  const out = { ...row };
  if (out.location && typeof out.location === 'string') {
    try { out.location = JSON.parse(out.location); } catch { out.location = null; }
  }
  return out as FarmRow;
}
