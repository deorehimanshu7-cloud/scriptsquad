import type { EventType } from "contracts";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonStringify, newId } from "../util";

export interface AgrifurEvent {
  id: string;
  type: EventType;
  user_id?: string | null;
  farm_id?: string | null;
  field_id?: string | null;
  payload?: unknown;
  created_at: string;
}

type Listener = (e: AgrifurEvent) => void;

/** In-process fan-out (single instance). For multi-instance deployments use a broker (see docs). */
const listeners = new Set<Listener>();

export function onEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function publishEvent(db: AppDb, e: Omit<AgrifurEvent, "id" | "created_at">): AgrifurEvent {
  const event: AgrifurEvent = { ...e, id: newId("evt"), created_at: nowIso() };
  db.conn
    .query("INSERT INTO events (id, user_id, farm_id, field_id, type, payload, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(event.id, event.user_id ?? null, event.farm_id ?? null, event.field_id ?? null, event.type, jsonStringify(event.payload ?? {}), event.created_at);
  for (const l of listeners) l(event);
  return event;
}

export function recentEvents(
  db: AppDb,
  opts: { fieldId?: string; userId?: string; type?: string; limit?: number },
): AgrifurEvent[] {
  const limit = opts.limit ?? 50;
  const clauses: string[] = [];
  const params: string[] = [];
  if (opts.fieldId) {
    clauses.push("field_id = ?");
    params.push(opts.fieldId);
  }
  if (opts.userId) {
    clauses.push("user_id = ?");
    params.push(opts.userId);
  }
  if (opts.type) {
    clauses.push("type = ?");
    params.push(opts.type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.conn
    .query(`SELECT * FROM events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...params, String(limit)) as unknown as AgrifurEvent[];
  for (const r of rows) {
    r.payload = JSON.parse((r.payload as unknown as string) ?? "{}");
  }
  return rows.reverse();
}

export function registerEventsRoutes(db: AppDb) {
  return { db, publish: (e: Omit<AgrifurEvent, "id" | "created_at">) => publishEvent(db, e) };
}
