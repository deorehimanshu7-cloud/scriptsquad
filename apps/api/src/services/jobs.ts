import type { JobRecord, JobStatus, JobType } from "contracts";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonParse, jsonStringify, newId } from "../util";

export interface JobInput {
  type: JobType;
  fieldId?: string | null;
  userId?: string | null;
  detail?: unknown;
}

export function createJob(db: AppDb, input: JobInput): JobRecord {
  const id = newId("job");
  db.conn
    .query(
      "INSERT INTO jobs (id, user_id, field_id, type, status, detail, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(id, input.userId ?? null, input.fieldId ?? null, input.type, "QUEUED", jsonStringify(input.detail ?? {}), nowIso());
  return getJob(db, id);
}

export function getJob(db: AppDb, id: string): JobRecord {
  const row = db.conn.query("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRecord | undefined;
  if (!row) throw new Error(`job ${id} not found`);
  row.detail = jsonParse(row.detail as unknown as string, {});
  return row;
}

export function finishJob(db: AppDb, id: string, status: JobStatus, opts: { error?: string; detail?: unknown } = {}): JobRecord {
  db.conn
    .query(
      "UPDATE jobs SET status = ?, finished_at = ?, error = ?, detail = ? WHERE id = ?",
    )
    .run(status, nowIso(), opts.error ?? null, opts.detail ? jsonStringify(opts.detail) : null, id);
  return getJob(db, id);
}

export function markRunning(db: AppDb, id: string): void {
  db.conn.query("UPDATE jobs SET status = 'RUNNING', started_at = ? WHERE id = ?").run(nowIso(), id);
}

export function recentJobs(db: AppDb, opts: { fieldId?: string; limit?: number } = {}): JobRecord[] {
  const limit = opts.limit ?? 50;
  const rows = (opts.fieldId
    ? db.conn.query("SELECT * FROM jobs WHERE field_id = ? ORDER BY created_at DESC LIMIT ?").all(opts.fieldId, String(limit))
    : db.conn.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(String(limit))) as unknown as JobRecord[];
  for (const r of rows) r.detail = jsonParse(r.detail as unknown as string, {});
  return rows;
}

/** Recover: anything still RUNNING at boot is stale → FAILED. */
export function recoverStaleJobs(db: AppDb): void {
  db.conn.query("UPDATE jobs SET status='FAILED', finished_at=?, error='interrupted (process restart)' WHERE status='RUNNING'").run(nowIso());
}
