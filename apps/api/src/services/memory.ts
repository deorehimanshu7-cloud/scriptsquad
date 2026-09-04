import type { AppDb } from "../db";
import { nowIso } from "../db";
import { newId } from "../util";

export interface MemoryInput {
  userId: string;
  farmId: string;
  fieldId: string;
  kind: "world_model_change" | "action_taken" | "investigation_resolved" | "observation" | "verification" | "simulation_run" | "provider_change";
  refId?: string | null;
  title: string;
  summary?: string | null;
  happenedAt?: string;
}

export function addMemory(db: AppDb, input: MemoryInput): void {
  db.conn
    .query(
      "INSERT INTO farm_memory (id, user_id, farm_id, field_id, kind, ref_id, title, summary, happened_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      newId("mem"),
      input.userId,
      input.farmId,
      input.fieldId,
      input.kind,
      input.refId ?? null,
      input.title,
      input.summary ?? null,
      input.happenedAt ?? nowIso(),
      nowIso(),
    );
}

export function listMemory(db: AppDb, fieldId: string, limit = 200): unknown[] {
  return db.conn
    .query(
      "SELECT id, kind, ref_id, title, summary, happened_at FROM farm_memory WHERE field_id = ? ORDER BY happened_at DESC LIMIT ?",
    )
    .all(fieldId, String(limit));
}

export function listMemoryForUser(db: AppDb, userId: string, limit = 100): unknown[] {
  return db.conn
    .query("SELECT id, kind, ref_id, title, summary, happened_at, field_id FROM farm_memory WHERE user_id = ? ORDER BY happened_at DESC LIMIT ?")
    .all(userId, String(limit));
}
