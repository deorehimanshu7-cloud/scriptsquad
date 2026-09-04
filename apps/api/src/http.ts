import type { NextFunction, Request, Response } from "express";
import { ZodError, ZodSchema } from "zod";
import type { UserRecord } from "contracts";
import { randomUUID } from "node:crypto";
import { sha256hex, newId } from "./util";
import type { AppDb } from "./db";
import { nowIso, tsAddHours } from "./db";

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord;
      sessionTokenHash?: string;
      requestId: string;
    }
  }
}

export function requestContext(req: Request, _res: Response, next: NextFunction): void {
  req.requestId = newId("req");
  next();
}

export function corsMiddleware(allowedOrigin: string | null) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin ?? "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Device-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "X-Request-Id");
    if (_req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // A validation failure is a client error (400), never an internal one (500).
  // Returning 500 here used to dump the whole ZodError object into the log.
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: "VALIDATION", message: "Invalid request body", details: err.flatten() } });
    return;
  }
  // Malformed JSON from the body parser is a client error (400), not a 500.
  if (err instanceof SyntaxError && (err as { status?: number }).status === 400) {
    res.status(400).json({ error: { code: "BAD_JSON", message: "Request body is not valid JSON" } });
    return;
  }
  // 500s never echo the underlying error to the client (no SQL text, no paths,
  // no stack). The full detail goes to the server log only.
  console.error(`[api] unhandled ${req.method} ${req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
}

export function notFound(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } });
}

/** Validate a zod schema; throws 400 HttpError on failure. */
export function validate<T>(schema: ZodSchema<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, "VALIDATION", "Invalid request body", r.error.flatten());
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 8 });
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function createSession(db: AppDb, userId: string): { token: string; expires_at: string } {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const tokenHash = sha256hex(token);
  const expires_at = tsAddHours(nowIso(), Number(process.env.SESSION_TTL_HOURS ?? 720));
  db.conn
    .query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
    .run(tokenHash, userId, nowIso(), expires_at);
  return { token, expires_at };
}

export function requireAuth(db: AppDb) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
      if (!token) throw new HttpError(401, "UNAUTHORIZED", "Missing bearer token");
      const tokenHash = sha256hex(token);
      const row = db.conn
        .query(
          `SELECT u.id, u.email, u.name, u.role, u.created_at, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ?`,
        )
        .get(tokenHash) as
        | (UserRecord & { expires_at: string })
        | undefined;
      if (!row) throw new HttpError(401, "UNAUTHORIZED", "Invalid or expired session");
      if (new Date(row.expires_at).getTime() < Date.now()) {
        db.conn.query("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
        throw new HttpError(401, "UNAUTHORIZED", "Session expired");
      }
      const { expires_at: _exp, ...user } = row;
      req.user = user;
      req.sessionTokenHash = tokenHash;
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ---------------------------------------------------------------------------
// Field ownership
// ---------------------------------------------------------------------------
export interface FieldOwnerRow {
  id: string;
  farm_id: string;
  user_id: string;
  name: string;
}

export function getOwnedField(db: AppDb, fieldId: string, user: UserRecord): FieldOwnerRow {
  const row = db.conn
    .query("SELECT id, farm_id, user_id, name FROM fields WHERE id = ?")
    .get(fieldId) as FieldOwnerRow | undefined;
  if (!row) throw new HttpError(404, "FIELD_NOT_FOUND", "Field not found");
  if (row.user_id !== user.id && user.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "This field does not belong to the authenticated user");
  }
  return row;
}

export function getOwnedFarm(db: AppDb, farmId: string, user: UserRecord): { id: string; user_id: string; name: string } {
  const row = db.conn
    .query("SELECT id, user_id, name FROM farms WHERE id = ?")
    .get(farmId) as { id: string; user_id: string; name: string } | undefined;
  if (!row) throw new HttpError(404, "FARM_NOT_FOUND", "Farm not found");
  if (row.user_id !== user.id && user.role !== "admin") {
    throw new HttpError(403, "FORBIDDEN", "This farm does not belong to the authenticated user");
  }
  return row;
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per process). Documented as development-grade.
// ---------------------------------------------------------------------------
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      next(new HttpError(429, "RATE_LIMITED", "Too many requests — try again shortly"));
      return;
    }
    arr.push(now);
    hits.set(key, arr);
    next();
  };
}

export function audit(db: AppDb, userId: string | undefined, action: string, target?: string, detail?: unknown): void {
  db.conn
    .query("INSERT INTO audit_log (id, user_id, action, target, detail, created_at) VALUES (?,?,?,?,?,?)")
    .run(newId("audit"), userId ?? null, action, target ?? null, detail ? JSON.stringify(detail) : null, nowIso());
}
