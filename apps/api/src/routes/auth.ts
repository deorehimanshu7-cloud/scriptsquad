import { Router } from "express";
import { z } from "zod";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { HttpError, createSession, hashPassword, requireAuth, verifyPassword, audit, rateLimit } from "../http";
import { config } from "../config";
import { newId } from "../util";
import type { UserRecord } from "contracts";

const registerSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(254),
  // min 8 chars; must contain at least one non-whitespace character (a
  // password of only spaces passes minLength but is not a credential).
  password: z
    .string()
    .min(8)
    .max(200)
    .refine((p) => /\S/.test(p), { message: "password must not be only whitespace" }),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export function authRoutes(db: AppDb): Router {
  const r = Router();

  /**
   * Demo-account availability signal for the auth page. Development only:
   * enabled by SEED_DEMO_ON_BOOT (default 1 outside production) and reported
   * available only when the seeded user actually exists in this database.
   * The endpoint never reveals the demo password and is disabled in
   * production builds (NODE_ENV=production).
   */
  // NOTE: this router is mounted at "/api/auth" (see index.ts), so route
  // paths are relative: /api/auth/demo, /api/auth/register, …
  r.get("/demo", (_req, res) => {
    const devSeedEnabled = config.seedDemoOnBoot && process.env.NODE_ENV !== "production";
    if (!devSeedEnabled) {
      res.json({ available: false, email: null, note: "Development demo account is disabled in this environment." });
      return;
    }
    const row = db.conn.query("SELECT id FROM users WHERE email = ?").get(config.demoEmail) as { id: string } | undefined;
    res.json({
      available: !!row,
      email: row ? config.demoEmail : null,
      note: row
        ? "Development seed account — a real database user (bcrypt-hashed), usable via normal login."
        : "Development demo account is not seeded in this database yet. Run `bun run seed` once, or register a new account.",
    });
  });

  r.post("/register", rateLimit(8, 60_000), async (req, res, next) => {
    try {
      const body = registerSchema.parse(req.body);
      const email = body.email.toLowerCase().trim();
      if (config.allowedRegisterEmails.length > 0 && !config.allowedRegisterEmails.includes(email)) {
        throw new HttpError(403, "FORBIDDEN", "This email is not on the allowed registration list.");
      }
      const existing = db.conn.query("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) throw new HttpError(409, "EMAIL_TAKEN", "An account with this email already exists.");
      const passwordHash = await hashPassword(body.password);
      const id = newId("usr");
      db.conn
        .query("INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, email, body.name, passwordHash, "farmer", nowIso());
      const session = createSession(db, id);
      audit(db, id, "auth.register", `user:${id}`);
      const user = db.conn.query("SELECT id, email, name, role, created_at FROM users WHERE id = ?").get(id) as UserRecord;
      res.status(201).json({ user, token: session.token });
    } catch (e) {
      next(e);
    }
  });

  r.post("/login", rateLimit(15, 60_000), async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const email = body.email.toLowerCase().trim();
      const row = db.conn
        .query("SELECT id, email, name, role, created_at, password_hash FROM users WHERE email = ?")
        .get(email) as (UserRecord & { password_hash: string }) | undefined;
      // Same error for unknown email and wrong password — no user enumeration.
      if (!row) throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
      const ok = await verifyPassword(body.password, row.password_hash);
      if (!ok) throw new HttpError(401, "INVALID_CREDENTIALS", "Invalid email or password.");
      const session = createSession(db, row.id);
      audit(db, row.id, "auth.login", `user:${row.id}`);
      const { password_hash: _ph, ...user } = row;
      res.json({ user, token: session.token });
    } catch (e) {
      next(e);
    }
  });

  r.post("/logout", requireAuth(db), (req, res) => {
    if (req.sessionTokenHash) {
      db.conn.query("DELETE FROM sessions WHERE token_hash = ?").run(req.sessionTokenHash);
      audit(db, req.user!.id, "auth.logout", `user:${req.user!.id}`);
    }
    res.json({ ok: true });
  });

  r.get("/me", requireAuth(db), (_req, res) => {
    res.json({ authenticated: true, user: _req.user });
  });

  return r;
}