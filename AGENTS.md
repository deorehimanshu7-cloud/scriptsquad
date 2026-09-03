# AGENTS.md — AGRIFUR2 (repo: scriptsquad)

Orientation for AI coding sessions working in this repository.

## Identity

- **Product:** AGRIFUR2 — a field-centric agricultural intelligence operating
  system (real field → polygon → providers → evidence → world model →
  intelligence/investigation → 2D map + 3D digital twin → AI → farm memory).
- **Repository on GitHub:** `scriptsquad` (hackathon repo). This is the
  canonical remote — never create/rename/migrate the remote to another name.
- Monorepo layout: `backend/` (Express + TS API), `frontend/` (Vite + React +
  MapLibre + React Three Fiber), `shared/` (`@agrifur2/shared` types),
  `firmware/` (ESP32 reference), `scripts/` (E2E suites), `docs/`.

## Non-negotiable rules

1. **Truth over polish.** Never fabricate satellite imagery/dates, telemetry,
   confidence/risk percentages, provider status, or hardware states. Show
   `UNKNOWN / NO_DATA / AUTH_REQUIRED / NOT_CONFIGURED / WAITING_FOR_DEVICE`
   with a reason when real evidence does not exist.
2. **Preserve working architecture.** Fix and extend; never rebuild from
   scratch, never create a parallel implementation, never merge satellite
   sources into a fake fused image.
3. **Field isolation.** Every request is field-scoped; every workspace clears
   stale state on field switch; SSE is field-scoped.
4. **Domains stay separate.** weather = ENVIRONMENT, DEM = TERRAIN,
   satellite = EARTH_OBSERVATION, soil/crop split by provider + measurement
   semantics, hardware = PHYSICAL_HARDWARE.
5. **No secrets in code.** Only `.env.example` files are committed. Provider
   credentials stay backend-side. Real `.env`, `*.db`, `.freebuff/` are
   git-ignored.

## Continue from here

A new session should:

1. Read `docs/AGRIFUR2_CURRENT_STATE.md` and `docs/AGRIFUR2_CONTINUE.md`.
2. Inspect the actual repository state (do not assume).
3. Run: backend `npm test`, `node scripts/e2e-live.mjs` +
   `scripts/e2e-hardware.mjs` (server on `:3001`), frontend `npx tsc --noEmit`
   and `npm run build`.
4. Fix highest-impact gaps, verify live, and report factually what was called,
   what returned, and what remains blocked.

## Environment

- Backend: `PORT=3001 DATABASE_MODE=sqlite-dev npm run dev` (sandbox);
  production target `DATABASE_MODE=postgres` + PostGIS migrations.
- Demo account (development only): `demo@agrifur2.local` / `demo-password-123`
  (labeled DEVELOPMENT_SEED).
- Frontend dev server runs on `:5174`; backend on `:3001`.
