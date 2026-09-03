# Continue AGRIFUR2 — Session Handoff

Read this file AND `docs/AGRIFUR2_CURRENT_STATE.md` first, then continue the
existing implementation. **Do not redesign from scratch. Do not create a second
architecture. Do not fabricate data.**

## The single most important rule

AGRIFUR2 must never look more real than its data:

- Real provider result → persist → evidence → world model → UI/map/3D.
- No evidence → `UNKNOWN` / `NO_DATA` / `AUTH_REQUIRED` **with a reason why**.
- Never: fake satellite imagery/dates, fake telemetry, fake confidence
  percentages, fake provider status, stock/Unsplash farm photos as satellite,
  invented pH/EC/groundwater, dev seed data masquerading as observations.
- Evidence states: `OBSERVED / DERIVED / ESTIMATED / HISTORICAL /
  REANALYSIS / MODEL_DERIVED / MODELLED / PREDICTED / SIMULATED / UNKNOWN`.
- Domains are strict: weather = ENVIRONMENT, DEM = TERRAIN, soil vs crop are
  split by provider + measurement semantics, satellite = EARTH_OBSERVATION,
  hardware = PHYSICAL_HARDWARE. Evidence UI classifies by `domainOf()` in
  `frontend/src/features/evidence/EvidencePage.tsx`.

## How to run

```bash
# Backend (sqlite-dev is the sandbox mode; postgres is the production target)
cd backend && npm install
PORT=3001 DATABASE_MODE=sqlite-dev npm run dev      # or: npm run build && node dist/server.js
# seed demo data if a fresh DB:
npm run db:migrate && AGRIFUR2_SEED=development npm run db:seed

# Frontend
cd frontend && npm install && npm run dev           # Vite dev server

# Verification
cd backend && npm test                               # Jest: 27 pass + 2 PostGIS-gated skip
node scripts/e2e-live.mjs                            # needs server on :3001 with demo account
node scripts/e2e-hardware.mjs
cd frontend && npx tsc --noEmit && npm run build
```

Demo account (development only): `demo@agrifur2.local` / `demo-password-123`,
field `yashwant nagar` (4.68 ha). Demo data is labeled DEVELOPMENT_SEED and
never shown as production truth.

## Key invariants to preserve

- Every field request goes through `fieldIsolation` + `authenticate`
  middleware — no cross-field leakage, ever.
- SSE stream (`/api/system/events/stream`) is field-scoped; World + Twin refetch
  on `OBSERVATION_RECEIVED / SENSOR_CONNECTED / WORLD_MODEL_UPDATED`.
- World Model coverage is a labelled descriptor (`EVIDENCE_COVERAGE`, counts +
  per-domain AVAILABLE/MISSING), never called confidence.
- Satellite sources stay separate (Sentinel-2 / Sentinel-1 / Landsat / Indian
  EO) — fusion happens at the evidence/intelligence level, never as a fake
  fused image. UI shows LATEST ACQUISITION and BEST QUALIFIED independently.
- Digital Twin: one geographic transform for every layer
  (x=(lng−cLng)/scale, z=(lat−cLat)/scale; extrude +Z then rotateX(π/2) for
  sub-surface bands). Explode is a pure-Z visual offset. Modelled content is
  labeled MODELLED. Imagery failing to load → honest chip, never a fake texture.
- pH/EC from SoilGrids are ESTIMATED with model uncertainty; without evidence
  they are UNKNOWN. AI never invents measurements.
- All i18n strings route through `frontend/src/lib/i18n/locales/{en,hi,mr}.json`.

## Where the demo gaps are (highest impact first)

1. **Credentials to configure** (server-side only): `COPERNICUS_CLIENT_ID/
   _SECRET`, `BHOONIDHI_USER_ID/_PASSWORD`, CGWB/water source keys. Once set,
   run satellite search/process to get real band assets + NDVI (DERIVED), and
   the honest AUTH_REQUIRED states become live data.
2. **PostGIS execution**: `docker compose up -d postgres`, migrate, run the
   gated integration tests, then re-verify sqlite-independent spatial queries.
3. **Physical demo**: MQTT broker + ESP32 from `firmware/` — real telemetry →
   evidence → Twin markers → intelligence live.
4. **In-browser QA**: screenshots of the WebGL Twin can lose context in some
   sandbox webviews; verify 3D via DOM/status chips, and on real hardware via
   the browser console.

## Ground rules for the next session

- Typecheck/build/test after every meaningful change (loop, don't accumulate).
- Audit strings `mock|fake|dummy|placeholder|Unsplash|Math.random` + statuses
  `Connected|Online|AVAILABLE|successRate` before calling anything done.
- Produce a factual report: what was called, what returned, what is still
  blocked — never "should work".
