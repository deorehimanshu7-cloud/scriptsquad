# AGRIFUR2 — Field-Centric Agricultural Intelligence Operating System

AGRIFUR2 is a geographically anchored farm intelligence platform. A real field
polygon is the canonical spatial truth; real evidence (satellite catalogs,
weather model output, DEM, soil-model estimates, device telemetry) is persisted,
fused into a per-field **World Model**, and analysed by truthful engines —
anomaly, risk, uncertainty, contradiction, investigation, hypothesis,
next-best-observation — before any recommendation or AI reply is produced.

**Truthfulness is the core contract.** The system never fabricates satellite
imagery, NDVI, soil pH/EC, groundwater depth, telemetry, confidence
percentages, or provider availability. Missing data answers `UNKNOWN`,
`NO_DATA`, `UNAVAILABLE` or `AUTH_REQUIRED` and the UI shows exactly that.

---

## Repository layout

```
backend/    Express + TypeScript API. Repository data layer with two drivers:
            postgres (PostGIS, canonical/production) and sqlite-dev (labelled
            development fallback). Provider adapters, intelligence engines,
            MQTT ingestion, events/jobs, seed tooling, jest tests.
frontend/   React + Vite + TypeScript. MapLibre 2D World, Three.js Digital
            Twin, and specialized workspaces (Intelligence, Evidence,
            Investigations, Satellite, Sensors, Weather, Environment
            [soil/terrain/water/crop], History, Simulation, Assistant, System).
shared/     @agrifur2/shared — domain types + geometry utilities. Used by the
            sqlite-dev driver (labelled, never PostGIS) and client previews.
database/   migrations (PostGIS) live in backend/src/database/migrations;
            sqlite-dev schema mirrors it column-for-column.
infra/      docker-compose.yml: PostgreSQL+PostGIS 16, Redis 7, EMQX MQTT 5,
            MinIO.  (docker-compose.yml at repository root)
scripts/    e2e-live.mjs — live end-to-end exercise against a running API.
docs/       Architecture & API notes.
```

## Quick start

### A. Development fallback (no Docker / no PostgreSQL)

```bash
npm install
DATABASE_MODE=sqlite-dev npm run dev:backend   # API on :3001 — clearly labelled sqlite-dev
npm run dev:frontend                            # Vite on :5173 (proxies /api → :3001)
```

The health endpoint and UI surface `database_mode: sqlite-dev`. Geometry
metrics in this mode are computed by the shared geodesic utilities and are
labelled `metrics_computed_by: "sqlite-dev-geo"` — **never** presented as
PostGIS output.

### B. Production architecture — PostgreSQL + PostGIS (canonical)

```bash
npm install
docker compose up -d postgres          # PostgreSQL + PostGIS 16 (migration auto-applies
                                       #   on first boot; see database/migrations)
cp .env.example .env                   # DATABASE_MODE=postgres, DB_PASSWORD=postgres …
npm run db:migrate                     # idempotent schema migration (PostGIS functions)
npm run dev:backend                    # API on :3001 (verifies PostGIS availability)
npm run dev:frontend                   # Vite on :5173
```

The server automatically uses PostGIS when PostgreSQL is reachable: field
metrics come from `ST_Area` (projected equal-area CRS via `ST_Transform`),
`ST_Perimeter`, `ST_Centroid`, `ST_Envelope`, and spatial predicates use
`ST_Intersects`/`ST_Within`/`ST_Contains`/`ST_DWithin` on SRID 4326 geometry.

### Seed (optional, development only)

```bash
AGRIFUR2_SEED=development npm run db:seed   # all seed rows are labelled DEVELOPMENT_SEED
```

## Environment

See `.env.example` (root) and `backend/.env.example`. No credentials are
required to run: credential-free adapters work out of the box, and anything
else reports `AUTH_REQUIRED`.

## Providers — live-verified state

| Provider | Purpose | State | Notes |
| --- | --- | --- | --- |
| Copernicus Data Space STAC | Sentinel-2 search/footprints | **IMPLEMENTED / AVAILABLE** (catalog search, no auth) | Official endpoint `https://stac.dataspace.copernicus.eu/v1`. Real products stored as EO evidence. Band/asset download → `AUTH_REQUIRED` (needs `COPERNICUS_CLIENT_ID/_SECRET`). |
| Landsat Collection 2 (earth-search STAC) | Landsat search | **IMPLEMENTED** — catalog adapter wired into search/`latest` | earth-search.aws.element84.com |
| Open-Meteo | Current/forecast weather | **IMPLEMENTED / AVAILABLE** | Model output → `MODEL_DERIVED`/`PREDICTED`; ERA5 archive history → `REANALYSIS`. |
| Open-Meteo elevation (DEM) | Terrain elevation sample | **IMPLEMENTED / AVAILABLE** | `DERIVED` from DEM sample; never an on-site survey. |
| SoilGrids v2 (ISRIC) | Soil property model estimates | **IMPLEMENTED / AVAILABLE** (slow: per-property queries) | Every value `ESTIMATED` with model uncertainty + depth + raw-unit provenance. pH/EC are *estimates*, explicitly labelled, never presented as sensor readings. |
| Bhoonidhi / NRSC (India) | Authenticated catalog | **IMPLEMENTED SCHEMA** (config + AUTH_REQUIRED path) | Needs `BHOONIDHI_CLIENT_ID/_SECRET`; no credentials fabricated. |
| CGWB / India-WRIS (water) | Groundwater / surface water | **NO_DATA (truthful)** | Credential-gated national datasets; groundwater depth is never fabricated or estimated. |
| MQTT broker (EMQX) | IoT transport | **UNAVAILABLE when unset** | `MQTT_BROKER` optional; HTTPS telemetry works without it. |
| LLM (OpenAI-compatible) | AI assistant | **AUTH_REQUIRED without AI_API_KEY** → local grounded engine | Assistant only reasons over stored, field-scoped evidence. |

## API surface (all under `/api`, JSON envelope `{ success, data|error }`)

- `auth` — register / login / refresh / logout / me
- `farms`, `fields` — farm CRUD; field CRUD with canonical PostGIS geometry,
  AOI import, area/perimeter/centroid/bbox, geometry-version history
- `fields/:id/world-model` — fused per-field state (aggregates all layers)
- `fields/:id/analyze` — evidence → anomalies/risks/uncertainty/contradictions
- `fields/:id/intelligence` + `anomalies|risks|uncertainty|contradictions|next-observations`
- `fields/:id/evidence` — evidence explorer (+relationships, provenance)
- `fields/:id/investigations` — case lifecycle, hypotheses, NBO, resolve
- `fields/:id/satellite` — latest / search / products / process / indices / timeseries / changes
- `fields/:id/weather` — current / forecast / history / anomalies
- `fields/:id/soil`, `terrain`, `water`, `crop` (+ `fetch` for soil/terrain)
- `fields/:id/sensors|devices|observations[/latest|timeseries]|hardware-health`
- `devices` — register (per-device key), list/detail/patch, derived status,
  heartbeat, telemetry, **sync** (offline replay, idempotent), commands
  (whitelisted downlink) + acks, device events
- `sensors/:id` — patch, status, calibrations (CALIBRATED / EXPIRED / NOT_CALIBRATED)
- `voice-devices` — register / heartbeat / sync (offline cache with real
  timestamps) / status (edge voice unit = device of type `voice_assistant`)
- `fields/:id/simulation`, `digital-twin`, `farmer-observations`, `verifications`
- `assistant` — sessions / messages / audio / transcribe (field-scoped,
  tool-grounded: getSensors/getDeviceStatus/getSensorHistory/getCalibration added)
- `system` — health, provider health, jobs, events (+SSE stream), audit

Every field-scoped route enforces server-side ownership isolation.

## Tests

```bash
npm run test:backend        # unit + integration on sqlite-dev (fast, hermetic)
DATABASE_MODE=postgres npm run test:backend   # includes the PostGIS-gated suite
npm run test:frontend       # typecheck + build gate
node scripts/e2e-live.mjs   # live E2E against a running API (needs server on :3001)
```

Build: `npm run build` (shared → backend → frontend).

## Hardware & edge voice (see `firmware/` for the ESP32 reference build)

- Transport: MQTT 5 (`agrifur/v1/devices/{id}/telemetry|heartbeat|status|events|commands|responses`) **or** HTTPS. MQTT is never the database — PostgreSQL persists canonical observations; raw payloads are preserved verbatim in `telemetry_raw` with RECEIVED→VALIDATED/SUSPECT/REJECTED/DUPLICATE states.
- Deployment is resolved **server-side** (device → active deployment → field); client-supplied `field_id` is never trusted.
- Every valid physical reading becomes an observation **and** OBSERVED evidence (source PHYSICAL_HARDWARE), so anomaly/contradiction engines and the World Model see the hardware layer.
- Device state (`ONLINE/STALE/OFFLINE/MAINTENANCE/ERROR/UNKNOWN`) is derived from real heartbeats/telemetry (120 s staleness), never hardcoded. Sensor trust/quality is `NOT_ASSESSED` unless genuinely computed.
- Offline edge: ESP32 journals readings locally and replays them via `POST /api/devices/:id/sync`; the backend dedupes by `(device_id, message_id)` — replays never duplicate.
- Downlink: whitelisted commands only (`request_sensor_reading`, `request_device_status`, `sync_device`, `sync_time`, `firmware_update_check`, `set_sampling_interval`); **actuator commands are rejected unless `AGRIFUR2_ENABLE_ACTUATORS=true`** and never exposed to the AI.
- Voice: the LLM never runs on the ESP32. Online questions hit the backend assistant tools (sensor-aware, field-isolated). Offline, the voice device answers only from the last verified cache (sync response quotes real `observed_at` — never “current”), and says so when data is unavailable. English/Hindi/Marathi follow the UI language.

## Truthfulness rules (enforced)

1. No fake data: missing → `UNKNOWN` / `NO_DATA` / `UNAVAILABLE` / `AUTH_REQUIRED`.
2. Semantics are always labelled: `OBSERVED / DERIVED / ESTIMATED / HISTORICAL /
   REANALYSIS / MODEL_DERIVED / PREDICTED / SIMULATED / UNKNOWN`.
3. Evidence count is *Evidence Coverage*, never “confidence”. Quality is
   `NOT_ASSESSED` unless genuinely computed.
4. One canonical geometry drives DB, 2D map, satellite AOI, World Model, 3D twin.
5. Simulations never mutate the live World Model.
