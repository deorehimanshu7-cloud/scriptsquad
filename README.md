# AGRIFUR

Field-centric agricultural intelligence: real fields, physical sensors, satellite observations and grounded AI reasoning, connected into one trustworthy farm decision system.

## Mission

To empower farmers with trusted intelligence by combining physical sensors, satellite data, AI reasoning and voice interaction for safe, smart and sustainable farm decisions.

## Core architecture

```
REAL FIELD
  → GEO-ANCHORING     (field polygon in real coordinates)
  → EVIDENCE          (observed / derived / estimated / historical / predicted / simulated)
  → FARM WORLD MODEL  (field-scoped snapshot of every domain)
  → INTELLIGENCE      (anomaly · risk · uncertainty · contradiction engines)
  → INVESTIGATION     (hypotheses + next best observation)
  → ACTION            (evidence-linked recommendations)
  → VERIFICATION      (re-check after action)
  → LEARNING
```

Every value in the UI carries an explicit truth state. AGRIFUR never fabricates sensor readings, satellite scenes, weather, soil or confidence numbers — when a provider is unavailable it reports `NOT_CONFIGURED`, `AUTH_REQUIRED`, `NO_DATA` or `DATA_QUALITY_FAILURE` instead.

## Technology

- **Frontend** — React 18 / TypeScript / Vite, MapLibre GL (2D), Three.js (3D Digital Twin), Framer-style motion-light UI with en/hi/mr interface text
- **Backend** — Node.js / Bun / Express, zod validation, server-side sessions (bcrypt + hashed bearer tokens)
- **Data** — SQLite (auto-migrating schema; development default), documented path to external Postgres for production
- **GIS / Earth observation** — field polygons, WGS84 geo-anchoring, Copernicus Data Space STAC (Sentinel-2 / Sentinel-1 metadata), Open-Meteo weather, OpenTopoData/SRTM terrain, ISRIC SoilGrids, OSM surface water
- **IoT** — MQTT ingestion (ESP32 reference firmware in `hardware/`), HTTPS device gateway, validation + dedupe + OBSERVED evidence; plus a DEVELOPMENT-only LAN HTTP path (`POST /api/dev/hardware/telemetry`, `hardware/esp32/agrifur_esp32_http/`) for the simplest real-ESP32 hookup without a broker
- **AI** — grounded assistant over field evidence; LLM mode via an OpenAI-compatible API, local grounded fallback when no key is configured; voice input via the Web Speech API (browser-side, no audio leaves the device)
- **3D Digital Twin** — real polygon + real DEM-derived terrain, thick exploded evidence layers, soil cutaway, click-to-inspect

## Repository structure

```
├── apps/
│   ├── api/       backend — Express server, providers, MQTT subscriber, engines, schema, tests
│   └── web/       frontend — Vite + React SPA, all workspaces under src/pages/app
├── packages/
│   └── contracts/ shared TypeScript types (type-only imports; erased at runtime)
├── hardware/      ESP32 reference firmware + development Mosquitto configuration
├── scripts/       live verification suites (smoke, final acceptance, water)
├── docs/          implementation status + deployment guide
├── env.example    every environment variable, grouped public vs server-only
├── package.json   single-package root: all scripts + hoisted dependencies
├── Dockerfile + docker-compose.yml   full-stack container (Bun) + one-command stack
```

The repository is intentionally **one deployable package at the root** (no npm workspaces) so any Node host can install and build it.

## Local development

Requires [Bun](https://bun.sh) (Node ≥ 20).

```bash
bun install          # install dependencies
cp env.example .env  # optional overrides (secrets stay out of git)
bun run dev          # API + web dev servers
```

Build + run the production server (single process serving the SPA and the API):

```bash
bun run build        # typecheck + vite build (apps/web/dist)
bun run preview      # build, then start the API which serves dist/ on :8787
bun run start        # start the API directly (dist must already be built)
```

Checks:

```bash
bun run typecheck    # tsc for the API and the web app
bun test             # backend unit + integration tests (103)
bun run build:api    # bundle the API (dist/index.js)
node scripts/smoke_live.mjs   http://localhost:8787   # live smoke suite
node scripts/verify_final.mjs http://localhost:8787   # final acceptance suite
```

A **DEVELOPMENT-SEED** demo account (`demo@agrifur.dev`, development-only password documented in the seed script) is created automatically on a fresh database when `SEED_DEMO_ON_BOOT=1`. It is labelled in the UI and never enabled in production by default.

## Environment variables

See [`env.example`](env.example). All secrets are **server-only** — real keys (LLM, Copernicus OAuth, MQTT credentials) are injected through the host's environment, never committed. The SPA is same-origin by default and reads no secrets; when split-hosting, set the non-secret build-time `VITE_API_URL` (or a runtime `window.__AGRIFUR_API__`) to the API origin.

## Deployment

- **Frontend on Vercel:** the SPA is plain Vite output. Create a Vercel project with **Root Directory = `apps/web`**, framework preset **Vite** (`bun install`/`npm install` → `vite build`, output `dist`). Because the SPA is same-origin, the API must be reachable at `/api` — configure a Vercel rewrite from `/api/*` to your hosted backend, or serve the frontend from the unified host below.
- **Backend:** the API is a long-running Bun/Express process with a continuous-monitoring worker, MQTT subscriber and scheduled provider jobs — it must run on a persistent host (VM / container / PaaS with a real server process), not as a serverless function. Point `WEB_ORIGIN` / CORS at the frontend origin when split-hosting.
- **Database:** SQLite file (persistent volume). For production scale, the schema layer is ready for an external Postgres database — document your instance and set `DATABASE_PATH`/connection accordingly.
- **MQTT:** the broker must be reachable from the backend host; set `MQTT_BROKER_URL` (+ credentials). The ESP32 reference firmware publishes to `AGRIFUR/field/{field}/device/{device}/telemetry`.
- **AI:** optional. Set `LLM_API_KEY` + `LLM_BASE_URL` + `LLM_MODEL`; without them the assistant stays in labelled grounded-fallback mode.

Full details: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Data truth

`OBSERVED` (sensor/provider measurement) ≠ `DERIVED` (computed from observations) ≠ `ESTIMATED` (modelled, e.g. SoilGrids) ≠ `PREDICTED` (forecast) ≠ `SIMULATED` (what-if runs, never merged into observed evidence). Provider states: `AVAILABLE`, `PARTIAL`, `NO_DATA`, `NOT_CONFIGURED`, `AUTH_REQUIRED`, `TIMEOUT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `DATA_QUALITY_FAILURE`, `UNKNOWN`. Intelligence outputs cite the evidence they came from; uncertainty rises when evidence is missing or conflicting.

## Security

Never commit secrets. `.env`, database files and build output are git-ignored. Passwords are bcrypt-hashed, sessions are server-side, field data is authorization-checked server-side, telemetry is validated and field-scoped, and realtime streams are isolated per user. Report credentials as suspected of exposure by rotating them.
