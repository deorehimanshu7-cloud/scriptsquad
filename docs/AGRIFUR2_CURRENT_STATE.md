# AGRIFUR2 — Current State (checkpoint)

_Last updated: pre-SIH checkpoint. Read together with `docs/AGRIFUR2_CONTINUE.md`._

## What AGRIFUR2 is

A field-centric agricultural intelligence operating system:

```
REAL FIELD → FIELD POLYGON → AOI → REAL PROVIDER DATA → EVIDENCE
→ FARM WORLD MODEL → INTELLIGENCE → INVESTIGATION → 2D MAP / 3D DIGITAL TWIN
→ AI ASSISTANT → FARM MEMORY
```

The field is the root object. No global/demo/random data is presented as real.
Non-negotiable truth rule: never fabricate measurements, imagery, dates,
confidence, provider status, or hardware states. Missing/unauthorized states
are shown as `UNKNOWN / NO_DATA / AUTH_REQUIRED / NOT_CONFIGURED /
WAITING_FOR_DEVICE` with an explanation of why.

## Repository layout (this checkout)

| Path | Purpose |
|---|---|
| `backend/` | Express + TypeScript API (`src/server.ts`), provider orchestration, intelligence engines |
| `backend/src/services/providers/adapters/` | Copernicus CDSE STAC, Landsat Earth Search C2, Open-Meteo (weather/DEM), SoilGrids, Bhoonidhi (cred-gated), water/CGWB (cred-gated) |
| `backend/src/data/` | Evidence, satellite products, weather/soil/water/terrain stores, intel, sensors |
| `backend/src/database/migrations/` | `001_initial_schema.sql` (Postgres/PostGIS-first, sqlite-dev fallback) |
| `frontend/` | Vite + React + TS, MapLibre GL (World map), React Three Fiber (Digital Twin), i18n en/hi/mr |
| `shared/` | Shared types (`@agrifur2/shared`) |
| `scripts/` | Live E2E suites: `e2e-live.mjs` (37 checks), `e2e-hardware.mjs` (28 checks) |
| `firmware/` | ESP32 PlatformIO reference firmware + `src/secrets.example.h` — clearly labeled not physically tested here |
| `docs/` | Provider dependencies, data truth model, current state, continuation guide |

## Database

- `DATABASE_MODE=postgres` (production target, PostGIS migrations included).
- `DATABASE_MODE=sqlite-dev` (development fallback — visibly identified as
  `sqlite-dev` in `/api/health` and UI). Geometry metrics use shared geodesic
  utilities, NOT PostGIS, in sqlite mode.
- Live sandbox currently runs sqlite-dev (`backend/agrifur2.db`, git-ignored).

## Verified working (last full pass, before this checkpoint)

| Area | Status |
|---|---|
| Auth (JWT), farms, fields, geometry (EPSG:4326) | VERIFIED |
| Field isolation across every workspace | VERIFIED (state cleared + SSE field-scoped) |
| World page = full-viewport spatial map, real footprints, evidence timeline | VERIFIED |
| Satellite explorer — real CDSE STAC + Landsat products, LATEST vs BEST QUALIFIED, per-source separation, preview probe reasons | VERIFIED (S2 `S2A_MSIL2A…` cloud 28.55%; LC08 20.35%; LC09 2.32%) |
| Weather Open-Meteo (MODEL_DERIVED/REANALYSIS labels) | VERIFIED |
| SoilGrids ESTIMATED per-property + evidence-linked | VERIFIED |
| Terrain DEM elevation (DERIVED) — evidence domain `TERRAIN` | VERIFIED |
| Evidence domain separation (weather ≠ terrain, soil ≠ crop) | VERIFIED |
| World Model coverage descriptor (never "confidence %") | VERIFIED |
| Anomalies/risks/uncertainty only from real engine runs; UI now runs analysis in place | VERIFIED |
| Intelligence page auto-queries `/world-model`, `/intelligence`, shows NOT_ANALYZED + RUN ANALYSIS | VERIFIED |
| Digital Twin: real field geometry over real Esri World Imagery (OBSERVED), camera fit by real extent, MODELLED crop, sub-surface soil/root-zone/water cutaway stack + explode (Z-only) | VERIFIED (geometry + layers; WebGL capture unstable in sandbox webview) |
| Sensors/devices/telemetry + SSE realtime | VERIFIED (28 hardware E2E; no physical device in sandbox) |
| Grounded AI (local engine without key; LLM adapter = AUTH_REQUIRED) | VERIFIED |
| Builds/tests | Frontend tsc+build green; backend Jest 27 pass + 2 PostGIS-gated skip; e2e-live 37/37; e2e-hardware 28/28 |

## Known blockers (exact)

1. **PostGIS live run** — not executed against a live instance here.
   Fix: `docker compose up -d postgres` → `DATABASE_MODE=postgres npm run db:migrate` → run the gated PostGIS integration suite.
2. **Copernicus raster/NDVI** — `COPERNICUS_CLIENT_ID/_SECRET` needed; UI truthfully shows AUTH_REQUIRED / preview probe reasons.
3. **Bhoonidhi + CGWB water** — credentials needed; adapters truthful without them.
4. **MQTT live path** — needs broker + physical ESP32 (firmware under `firmware/`, HARDWARE_NOT_CONNECTED).
5. **Landsat browse previews** — requester-pays AWS / USGS EarthExplorer login (verified redirect). No public raster; UI says so per provider.
6. **ESLint** — backend `npm run lint` exists; frontend lint script not configured.
