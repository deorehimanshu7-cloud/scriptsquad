import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "./index";
import { openDb, nowIso, type AppDb } from "./db";
import { seedDevelopmentData } from "./scripts/seed";
import { sha256hex } from "./util";
import { hashPassword, verifyPassword } from "./http";

/**
 * Authentication acceptance tests (HTTP level, real server):
 *  1. registration succeeds with valid data
 *  2. registration rejects malformed email
 *  3. registration rejects weak / whitespace-only passwords
 *  4. duplicate registration rejected
 *  5. password is hashed (bcrypt)
 *  6. plaintext password is never stored
 *  7. login succeeds with correct credentials
 *  8. login fails with wrong password
 *  9. login fails with unknown email (same error — no enumeration)
 * 10. session is created and persisted
 * 11. GET /api/auth/me works and never exposes secrets
 * 12. refresh / backend restart restores the session (token survives reopen)
 * 13. logout invalidates the session
 * 14. protected route rejects unauthenticated requests
 * 15. authenticated requests reach protected routes
 * 16. expired / invalid sessions are rejected
 * 17. demo seed creates a REAL account (bcrypt, login through the normal flow)
 * 18. demo seed is idempotent and never overwrites the password
 * 19. secrets (password hash / tokens / plaintext) never appear in responses
 * 20. database failure produces a safe generic error (no SQL/paths leaked)
 */

const PASSWORD = "agrifur-demo"; // documented development-seed credential, real password flow
const R = { "content-type": "application/json" } as const;

interface ServerCtx {
  app: ReturnType<typeof createApp>["app"];
  db: AppDb;
  server: ReturnType<ReturnType<typeof createApp>["app"]["listen"]>;
  base: string;
}

function listen(created: ReturnType<typeof createApp>): Promise<ServerCtx> {
  return new Promise((resolve) => {
    const server = created.app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ app: created.app, db: created.db, server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function post(base: string, path: string, body: unknown, token?: string) {
  const headers: Record<string, string> = { ...R };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
async function get(base: string, path: string, token?: string) {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}${path}`, { headers });
}

describe("authentication (HTTP, real server)", () => {
  let ctx: ServerCtx;
  let freshUser: { email: string; token: string; id: string };

  beforeAll(async () => {
    ctx = await listen(createApp(":memory:"));
    const res = await post(ctx.base, "/api/auth/register", {
      email: "fresh@auth.dev",
      name: "Fresh User",
      password: PASSWORD,
    });
    const body = (await res.json()) as { user: { id: string }; token: string };
    freshUser = { email: "fresh@auth.dev", token: body.token, id: body.user.id };
  });

  afterAll(() => {
    ctx.server.close();
  });

  test("1. registration succeeds with valid data", async () => {
    const res = await post(ctx.base, "/api/auth/register", { email: "one@auth.dev", name: "One", password: PASSWORD });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: Record<string, unknown>; token: string };
    expect(body.user.email).toBe("one@auth.dev");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(32);
  });

  test("2. registration rejects malformed email", async () => {
    const res = await post(ctx.base, "/api/auth/register", { email: "not-an-email", name: "X", password: PASSWORD });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION");
  });

  test("3. registration rejects weak / whitespace-only passwords", async () => {
    const short = await post(ctx.base, "/api/auth/register", { email: "weak@auth.dev", name: "W", password: "short" });
    expect(short.status).toBe(400);
    const spaces = await post(ctx.base, "/api/auth/register", { email: "space@auth.dev", name: "S", password: "        " });
    expect(spaces.status).toBe(400);
  });

  test("4. duplicate registration is rejected", async () => {
    const dup = await post(ctx.base, "/api/auth/register", { email: "one@auth.dev", name: "One Again", password: PASSWORD });
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe("EMAIL_TAKEN");
  });

  test("5. password is hashed with bcrypt", async () => {
    const row = ctx.db.conn.query("SELECT password_hash FROM users WHERE email = ?").get("one@auth.dev") as { password_hash: string };
    expect(row.password_hash).not.toBe(PASSWORD);
    expect(row.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/); // bcrypt ($2b$10$…)
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(true);
  });

  test("6. plaintext password is never stored anywhere on the user row", async () => {
    const cols = (ctx.db.conn.query("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
    for (const c of cols) {
      const row = ctx.db.conn.query(`SELECT "${c}" AS v FROM users WHERE email = ?`).get("one@auth.dev") as { v: unknown };
      expect(String(row.v ?? "")).not.toBe(PASSWORD);
    }
  });

  test("7. login succeeds with correct credentials", async () => {
    const res = await post(ctx.base, "/api/auth/login", { email: freshUser.email, password: PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string }; token: string };
    expect(body.user.id).toBe(freshUser.id);
    expect(typeof body.token).toBe("string");
  });

  test("8. login fails with wrong password", async () => {
    const res = await post(ctx.base, "/api/auth/login", { email: freshUser.email, password: "definitely-wrong" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CREDENTIALS");
  });

  test("9. login fails with unknown email (same error — no enumeration)", async () => {
    const res = await post(ctx.base, "/api/auth/login", { email: "ghost@auth.dev", password: PASSWORD });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
    expect(body.error.message).toBe("Invalid email or password."); // identical to wrong-password case
  });

  test("10. a session row is created and persisted in the DB", async () => {
    const before = (ctx.db.conn.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(freshUser.id) as { n: number }).n;
    const res = await post(ctx.base, "/api/auth/login", { email: freshUser.email, password: PASSWORD });
    const { token } = (await res.json()) as { token: string };
    const after = (ctx.db.conn.query("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(freshUser.id) as { n: number }).n;
    expect(after).toBe(before + 1);
    const row = ctx.db.conn.query("SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1").get(freshUser.id) as { token_hash: string };
    expect(row.token_hash).toBe(sha256hex(token)); // tokens are stored hashed, not raw
  });

  test("11. GET /api/auth/me works and never exposes secrets", async () => {
    const res = await get(ctx.base, "/api/auth/me", freshUser.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; user: Record<string, unknown> };
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe(freshUser.email);
    expect(body.user).not.toHaveProperty("password_hash");
    expect(body.user).not.toHaveProperty("password");
    expect(JSON.stringify(body)).not.toContain(PASSWORD);
  });

  test("12. session survives a backend restart (same database file)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "agrifur-auth-"));
    const dbFile = path.join(dir, "auth.db");
    try {
      const first = await listen(createApp(dbFile));
      const reg = await post(first.base, "/api/auth/register", { email: "persist@auth.dev", name: "Persist", password: PASSWORD });
      const { token } = (await reg.json()) as { token: string };
      first.server.close();
      first.db.conn.close();

      // "restart": reopen the SAME file, reuse the stored token (as the browser would)
      const second = await listen(createApp(dbFile));
      const me = await get(second.base, "/api/auth/me", token);
      expect(me.status).toBe(200);
      const body = (await me.json()) as { user: { email: string } };
      expect(body.user.email).toBe("persist@auth.dev");
      second.server.close();
      second.db.conn.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("13. logout invalidates the session", async () => {
    const res = await post(ctx.base, "/api/auth/login", { email: freshUser.email, password: PASSWORD });
    const { token } = (await res.json()) as { token: string };
    const out = await post(ctx.base, "/api/auth/logout", {}, token);
    expect(out.status).toBe(200);
    const me = await get(ctx.base, "/api/auth/me", token);
    expect(me.status).toBe(401);
    // a second logout with the dead token must also be rejected
    const out2 = await post(ctx.base, "/api/auth/logout", {}, token);
    expect(out2.status).toBe(401);
  });

  test("14. protected routes reject unauthenticated requests", async () => {
    const fields = await get(ctx.base, "/api/fields");
    expect(fields.status).toBe(401);
    const wm = await get(ctx.base, `/api/fields/${freshUser.id}/world-model`);
    expect(wm.status).toBe(401);
  });

  test("15. authenticated requests reach protected routes", async () => {
    const fields = await get(ctx.base, "/api/fields", freshUser.token);
    expect(fields.status).toBe(200);
    const body = (await fields.json()) as { fields: unknown[] };
    expect(Array.isArray(body.fields)).toBe(true);
  });

  test("16. expired and invalid sessions are rejected", async () => {
    // expired session (row exists but expires_at in the past)
    const expiredToken = "expired-session-token-abcdef";
    ctx.db.conn
      .query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)")
      .run(sha256hex(expiredToken), freshUser.id, nowIso(), new Date(Date.now() - 60_000).toISOString());
    const expired = await get(ctx.base, "/api/auth/me", expiredToken);
    expect(expired.status).toBe(401);
    // garbage token
    const garbage = await get(ctx.base, "/api/auth/me", "no-such-token");
    expect(garbage.status).toBe(401);
  });

  test("17. demo seed creates a real account that logs in through the normal flow", async () => {
    const db = openDb(":memory:");
    const res = seedDevelopmentData(db);
    expect(res.created).toBe(true);
    const row = db.conn.query("SELECT password_hash FROM users WHERE email = ?").get("demo@agrifur.dev") as { password_hash: string };
    expect(row.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(await verifyPassword("agrifur-demo", row.password_hash)).toBe(true);
    db.conn.close();
  });

  test("18. demo seed is idempotent and never overwrites the password", async () => {
    const db = openDb(":memory:");
    seedDevelopmentData(db);
    const hash1 = (db.conn.query("SELECT password_hash FROM users WHERE email = ?").get("demo@agrifur.dev") as { password_hash: string }).password_hash;
    const usersBefore = (db.conn.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    const again = seedDevelopmentData(db);
    expect(again.created).toBe(false);
    const usersAfter = (db.conn.query("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
    expect(usersAfter).toBe(usersBefore);
    const hash2 = (db.conn.query("SELECT password_hash FROM users WHERE email = ?").get("demo@agrifur.dev") as { password_hash: string }).password_hash;
    expect(hash2).toBe(hash1);
    db.conn.close();
  });

  test("19. no secrets appear in register/login/me responses", async () => {
    const email = `secrets@${Date.now()}.dev`;
    const reg = await post(ctx.base, "/api/auth/register", { email, name: "Secrets", password: PASSWORD });
    const regText = await reg.text();
    expect(regText).not.toContain(PASSWORD);
    expect(regText).not.toContain("password_hash");
    expect(regText).not.toContain("$2b$");

    const login = await post(ctx.base, "/api/auth/login", { email, password: PASSWORD });
    const loginText = await login.text();
    expect(loginText).not.toContain(PASSWORD);
    expect(loginText).not.toContain("password_hash");

    const token = (JSON.parse(loginText) as { token: string }).token;
    const me = await get(ctx.base, "/api/auth/me", token);
    const meText = await me.text();
    expect(meText).not.toContain(PASSWORD);
    expect(meText).not.toContain("password_hash");
    expect(meText).not.toContain(token); // the session token is never echoed back
  });

  test("20. database failure produces a safe generic error (no SQL/paths leaked)", async () => {
    const broken = await listen(createApp(":memory:"));
    broken.db.conn.close(); // simulate database outage
    const res = await post(broken.base, "/api/auth/login", { email: "x@auth.dev", password: PASSWORD });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/sqlite|database|not open|\.db|connection/i);
    broken.server.close();
  });
});

describe("auth rate limiting (brute-force protection)", () => {
  test("login endpoint rate-limits after the per-IP window", async () => {
    const ctx = await listen(createApp(":memory:"));
    try {
      // 15/min allowed; hammer with 25 rapid wrong-password attempts
      let got429 = false;
      for (let i = 0; i < 25; i++) {
        const res = await post(ctx.base, "/api/auth/login", { email: "rate@auth.dev", password: "wrong-pass" });
        if (res.status === 429) {
          got429 = true;
          break;
        }
      }
      expect(got429).toBe(true);
    } finally {
      ctx.server.close();
    }
  });
});

describe("password hashing primitives", () => {
  test("hashPassword produces a bcrypt hash and verifyPassword round-trips", async () => {
    const hash = await hashPassword("a-real-password-123");
    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(hash).not.toBe("a-real-password-123");
    expect(await verifyPassword("a-real-password-123", hash)).toBe(true);
    expect(await verifyPassword("a-real-password-124", hash)).toBe(false);
  });
});