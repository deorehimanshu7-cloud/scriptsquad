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

The repository is **already configured** for this. Import it into Vercel and
build — no dashboard settings to change, and no Root Directory override:
leave **Root Directory at the repository root**.

What the committed [`vercel.json`](../vercel.json) does:

| Setting | Value | Why |
|---|---|---|
| `framework` | `vite` | the SPA is plain Vite output |
| `installCommand` | `npm install` | Vercel runs Node/npm; Bun is not required for the static build |
| `buildCommand` | `tsc --noEmit -p apps/web/tsconfig.json && vite build apps/web` | typechecks, then builds only the SPA |
| `outputDirectory` | `apps/web/dist` | the build output is **not** at the repository root |
| `rewrites` | `/((?!api/).*) → /index.html` | SPA deep links (`/app/twin`) survive a refresh; `/api/*` is deliberately excluded so a missing backend returns an honest 404 instead of the HTML shell |

[`.vercelignore`](../.vercelignore) additionally excludes `apps/api`, `hardware`,
`voicebot`, `docs`, `scripts` and the Docker files from the upload, so Vercel
only ever builds and serves the static SPA.

### Wiring the API (the one remaining step)

The SPA is same-origin by default: it calls relative `/api/*`. Pick one:

1. **Same-origin rewrite (recommended).** Add a backend rewrite to
   `vercel.json`, listed **above** the SPA fallback because rewrites are matched
   in order:

   ```json
   "rewrites": [
     { "source": "/api/:path*", "destination": "https://<backend-host>/api/:path*" },
     { "source": "/((?!api/).*)", "destination": "/index.html" }
   ]
   ```

   The destination must be **HTTPS**. The SPA needs no rebuild to switch.
   Note that SSE (`/api/events/stream`) is a long-lived stream: if your backend
   host or plan cannot proxy it, the UI falls back to polling and says so.
2. **Direct origin.** Set `VITE_API_URL=https://<backend>` in the Vercel project
   environment and redeploy (build-time), or inject `window.__AGRIFUR_API__` at
   runtime (wins over the build-time value). The SPA then calls the backend
   cross-origin; the backend already sends CORS headers (`WEB_ORIGIN` for the
   allow-list, or `*`) including `Authorization`.

On the backend (Option A's server, on a persistent host) set `WEB_ORIGIN` to the
Vercel frontend origin and `PUBLIC_BASE_URL` accordingly.

### What will **not** run inside Vercel, and why (do not fake it)

- the Express API — long-lived process, not serverless
- the continuous monitoring worker / scheduled provider jobs — background timers
- the MQTT subscriber — persistent broker connection
- SSE realtime — long-lived stream
- SQLite file persistence — serverless filesystems are ephemeral

Those all live on the Option A/C host. Vercel serves the SPA only, and the UI
labels each capability with its truthful state (`NOT_CONFIGURED`, `NO_DATA`, …)
rather than pretending the backend is present.

## Option C — Docker (full stack, one origin)

The repository ships a `Dockerfile` + `docker-compose.yml` that build the web
bundle and run the **API + SPA as one process on Bun** (this repo uses
`bun:sqlite`, so the runtime must be Bun). Auth and every `/api` route share
the same origin — exactly like local/preview.

```bash
cp env.example .env            # optional secrets (LLM, Copernicus, MQTT…)
docker compose up -d --build   # http://localhost:8787, SQLite on the volume
```

- SQLite lives on the named volume `agrifur-data` (`DATABASE_PATH` =
  `/app/apps/api/data/agrifur.db`) — survives rebuilds.
- Set `WEB_ORIGIN` only if you later split the SPA to another origin.
- Deploy this image to any host that runs containers (VM, Docker PaaS) and
  put HTTPS in front of port 8787 for a production URL.

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
