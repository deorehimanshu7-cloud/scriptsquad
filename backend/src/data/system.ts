/**
 * System repository: events, jobs, audit log, provider requests, world-model
 * snapshots, conversations/messages.
 */
import { dbAll, dbGet, dbRun } from './db';
import { generateId } from '../database/sqlite';

// ── Events ──────────────────────────────────────────────────────────────────
export async function insertEvent(input: { type: string; fieldId?: string; userId?: string; data?: Record<string, unknown> }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO events (id, type, field_id, user_id, data) VALUES ($1,$2,$3,$4,$5)`,
    [id, input.type, input.fieldId || null, input.userId || null, input.data || {}]
  );
  return { id, type: input.type, field_id: input.fieldId || null, user_id: input.userId || null, data: input.data || {}, created_at: new Date().toISOString() };
}

export async function listEvents(input: { fieldId?: string; type?: string; limit?: number }): Promise<any[]> {
  const where: string[] = [];
  const params: any[] = [];
  if (input.fieldId) { where.push('field_id = $1'); params.push(input.fieldId); }
  if (input.type) { where.push(`type = $${params.length + 1}`); params.push(input.type); }
  const limit = input.limit || 200;
  const q = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  return dbAll(`SELECT * FROM events ${q} ORDER BY created_at DESC LIMIT ${limit}`, params);
}

// ── Jobs ────────────────────────────────────────────────────────────────────
export async function createJob(input: { type: string; fieldId?: string; params?: Record<string, unknown>; maxAttempts?: number }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO jobs (id, type, field_id, params, max_attempts) VALUES ($1,$2,$3,$4,$5)`,
    [id, input.type, input.fieldId || null, input.params || {}, input.maxAttempts || 3]
  );
  return dbGet(`SELECT * FROM jobs WHERE id = $1`, [id]);
}

export async function getJob(id: string): Promise<any | null> {
  return dbGet(`SELECT * FROM jobs WHERE id = $1`, [id]);
}

export async function listJobs(limit = 100): Promise<any[]> {
  return dbAll(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ${limit}`);
}

export async function updateJob(id: string, patch: { status?: string; result?: Record<string, unknown>; error?: string; attempts?: number }): Promise<void> {
  const sets: string[] = [];
  const params: any[] = [];
  const cols: Record<string, any> = {
    status: patch.status, result: patch.result, error: patch.error, attempts: patch.attempts,
  };
  for (const [k, v] of Object.entries(cols)) {
    if (v !== undefined) { params.push(v); sets.push(`${k} = $${params.length}`); }
  }
  params.push(new Date().toISOString());
  if (sets.length === 0) return;
  await dbRun(`UPDATE jobs SET ${sets.join(', ')}, updated_at = $${params.length} WHERE id = $${params.length + 1}`, [...params, id]);
}

// ── Audit log ───────────────────────────────────────────────────────────────
export async function audit(input: { userId?: string; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>; requestId?: string }): Promise<void> {
  await dbRun(
    `INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, details, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [generateId(), input.userId || null, input.action, input.entityType || null, input.entityId || null, input.details || {}, input.requestId || null]
  );
}

export async function listAudit(fieldUserId?: string, limit = 200): Promise<any[]> {
  if (fieldUserId) return dbAll(`SELECT * FROM audit_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT ${limit}`, [fieldUserId]);
  return dbAll(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ${limit}`);
}

// ── Provider request log ────────────────────────────────────────────────────
export async function logProviderRequest(input: { providerId: string; requestType: string; params?: Record<string, unknown>; status: string; responseData?: unknown; errorMessage?: string; latencyMs?: number }): Promise<void> {
  await dbRun(
    `INSERT INTO provider_requests (id, provider_id, request_type, params, status, response_data, error_message, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [generateId(), input.providerId, input.requestType, input.params || {}, input.status,
     input.responseData === undefined ? null : input.responseData, input.errorMessage || null, input.latencyMs ?? null]
  );
}

export async function recentProviderSuccessRate(providerId: string, hours = 24): Promise<{ success_rate: number | null; count: number }> {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const rows = await dbAll(
    `SELECT status FROM provider_requests WHERE provider_id = $1 AND created_at >= $2`,
    [providerId, since]
  );
  if (rows.length === 0) return { success_rate: null, count: 0 };
  const ok = rows.filter((r) => r.status === 'AVAILABLE').length;
  return { success_rate: Math.round((ok / rows.length) * 1000) / 1000, count: rows.length };
}

// ── World model snapshots ───────────────────────────────────────────────────
export async function saveWorldModelSnapshot(fieldId: string, worldModel: Record<string, unknown>, version = 1): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO world_model_states (id, field_id, world_model, version) VALUES ($1,$2,$3,$4)`,
    [id, fieldId, worldModel, version]
  );
  return dbGet(`SELECT * FROM world_model_states WHERE id = $1`, [id]);
}

export async function latestWorldModelSnapshot(fieldId: string): Promise<any | null> {
  return dbGet(`SELECT * FROM world_model_states WHERE field_id = $1 ORDER BY created_at DESC LIMIT 1`, [fieldId]);
}

export async function listWorldModelSnapshots(fieldId: string, limit = 50): Promise<any[]> {
  return dbAll(`SELECT id, field_id, version, created_at FROM world_model_states WHERE field_id = $1 ORDER BY created_at DESC LIMIT ${limit}`, [fieldId]);
}

// ── Conversations ───────────────────────────────────────────────────────────
export async function createConversation(input: { userId: string; fieldId?: string; language?: string }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO conversations (id, user_id, field_id, language) VALUES ($1,$2,$3,$4)`,
    [id, input.userId, input.fieldId || null, input.language || 'en']
  );
  return dbGet(`SELECT * FROM conversations WHERE id = $1`, [id]);
}

export async function getConversation(id: string, userId: string): Promise<any | null> {
  return dbGet(`SELECT * FROM conversations WHERE id = $1 AND user_id = $2`, [id, userId]);
}

export async function listConversationsForField(fieldId: string, userId: string): Promise<any[]> {
  return dbAll(`SELECT id, field_id, language, created_at, updated_at FROM conversations WHERE field_id = $1 AND user_id = $2 ORDER BY updated_at DESC`, [fieldId, userId]);
}

export async function listConversations(userId: string): Promise<any[]> {
  return dbAll(`SELECT id, field_id, language, created_at, updated_at FROM conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`, [userId]);
}

export async function touchConversation(id: string): Promise<void> {
  await dbRun(`UPDATE conversations SET updated_at = $1 WHERE id = $2`, [new Date().toISOString(), id]);
}

export async function addMessage(input: { conversationId: string; role: string; content: string; toolCalls?: any[]; evidenceRefs?: string[] }): Promise<any> {
  const id = generateId();
  await dbRun(
    `INSERT INTO conversation_messages (id, conversation_id, role, content, tool_calls, evidence_refs)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.conversationId, input.role, input.content, input.toolCalls || [], input.evidenceRefs || []]
  );
  await dbRun(`UPDATE conversations SET updated_at = $1 WHERE id = $2`, [new Date().toISOString(), input.conversationId]);
  return dbGet(`SELECT * FROM conversation_messages WHERE id = $1`, [id]);
}

export async function listMessages(conversationId: string): Promise<any[]> {
  return dbAll(`SELECT * FROM conversation_messages WHERE conversation_id = $1 ORDER BY created_at`, [conversationId]);
}
