# AGRIFUR — Deployment guide

This document states exactly what can run where. Nothing here pretends that
unavailable infrastructure is live — if a service below is missing, the UI
reports its truthful state (`NOT_CONFIGURED`, `AUTH_REQUIRED`, `NO_DATA`).

## Architecture split

```
Browser (SPA)
   │  same-origin /api/*  (or WEB_ORIGIN CORS when split-hosting)
   ▼
Bun/Express API server            ← must be a PERSISTENT process:
   • serves the built SPA (apps/web/dist)
   • REST API + auth (bcrypt + server-side sessions)
   • continuous-monitoring worker (provider jobs on fixed cadence)
   • MQTT subscriber (physical sensor bridge)
   • SSE realtime stream (field-scoped, per-user)
   ▼
SQLite (persistent volume)  +  external providers (STAC, weather, DEM, soil, water)
```

## Option A — unified host (recommended for a demo/SIH deployment)

One persistent server runs the API **and** serves the built frontend.

1. `bun install`
2. `bun run build` (typecheck + `vite build` → `apps/web/dist`)
3. `PORT=8787 bun run start`
4. Put it behind HTTPS, keep the process alive (systemd/Docker/PaaS),
   and give it a **persistent volume** for the SQLite file
   (`DATABASE_PATH`, default `apps/api/data/agrifur.db`).

Health: `GET /api/health`.

## Option B — frontend on Vercel, backend elsewhere

- **Vercel project:** Root Directory = `apps/web`, framework preset **Vite**
  (install `bun install` or `npm install`, build `vite build`, output `dist`).
- The SPA talks to the API in one of two ways:
  1. **Same-origin rewrite:** add a Vercel project rewrite from `/api/*` to
     `https://<backend>/api/*` (HTTPS destination) — the SPA keeps calling
     relative `/api/*`.
  2. **Direct origin:** build with `VITE_API_URL=https://<backend>` (or inject
     `window.__AGRIFUR_API__` at runtime, which wins) — then the SPA calls the
     backend cross-origin. The backend already sends CORS headers
     (`WEB_ORIGIN` for the allow-list, or `*`) including `Authorization`.
- Backend: run Option A's server on a persistent host, set `WEB_ORIGIN` to the
  Vercel frontend origin (CORS) and `PUBLIC_BASE_URL` accordingly.
- What will **not** run inside Vercel, and why (do not fake it):
  - the Express API — long-lived process, not serverless
  - the continuous monitoring worker / scheduled provider jobs — background timers
  - the MQTT subscriber — persistent broker connection
  - SSE realtime — long-lived stream
  - SQLite file persistence — serverless filesystems are ephemeral

## Database

- Current: SQLite at `DATABASE_PATH`, auto-migrated at boot (`schema.ts`).
  Backup the file; keep it on a persistent volume.
- Postgres: the schema layer is provider-agnostic and ready to be pointed at an
  external Postgres instance for production scale; document the connection as a
  server-only environment variable. GeoJSON polygons are stored/queried as text
  with computed centroids/bboxes, so no PostGIS requirement is introduced by the
  current code.

## MQTT (physical sensors)

```
ESP32 + DHT11 + soil moisture
   → MQTT broker (externally reachable from the backend host)
   → AGRIFUR backend subscriber
   → validation → OBSERVED evidence → World Model → UI
```

- Set `MQTT_BROKER_URL` (+ `MQTT_USERNAME`/`MQTT_PASSWORD` when the broker
  requires auth) on the backend host. Without it the provider card truthfully
  shows `NOT_CONFIGURED`.
- Topic layout: `AGRIFUR/field/{fieldId}/device/{deviceId}/telemetry`,
  `/heartbeat`, `/status`. Device → field ownership is resolved server-side.
- Reference firmware: `hardware/esp32/agrifur_esp32/agrifur_esp32.ino`;
  development Mosquitto config: `hardware/mosquitto/`.
- The browser never talks MQTT directly.

## Providers & credentials (all server-side)

| Service | Purpose | Requires |
|---|---|---|
| Copernicus Data Space STAC | Sentinel-2/Sentinel-1 product metadata | none (anonymous) |
| Copernicus OAuth | raster/preview access | `COPERNICUS_CLIENT_ID` + `COPERNICUS_CLIENT_SECRET` |
| Open-Meteo | weather model rows | none |
| OpenTopoData (SRTM/ASTER) | terrain/DEM | none |
| ISRIC SoilGrids maps server | soil estimates (labelled ESTIMATED) | none |
| OSM/Overpass | surface water context | none |
| LLM (OpenAI-compatible) | grounded assistant | `LLM_API_KEY` (+ `LLM_BASE_URL`, `LLM_MODEL`) |
| Bhoonidhi / ISRO | Indian EO (optional) | account credentials |
| MQTT broker | physical sensor telemetry | reachable broker + creds |

Every variable is documented in [`env.example`](../env.example). No provider is
ever mocked when credentials are missing.

## Verification before shipping

```bash
bun run typecheck
bun test
bun run build
bun run build:api
node scripts/smoke_live.mjs   http://localhost:8787
node scripts/verify_final.mjs http://localhost:8787
```

The smoke and acceptance suites exercise auth → fields → world model → evidence →
satellite → twin → sensors → providers → realtime isolation against a live
server.
