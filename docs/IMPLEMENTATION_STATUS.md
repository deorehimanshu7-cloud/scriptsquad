# AGRIFUR2 — Implementation status (verified)

_Last updated from live verification runs. "Implemented" means exercised against real providers or real API calls in
this environment, not just present as code._

## Legend

- ✅ **Implemented & verified live** — exercised end-to-end (real HTTP provider calls or real API flows)
- 🟡 **Implemented, partially verified / environment-limited**
- 🔑 **Credential-gated** — implemented code paths that need keys this environment does not have
- ⛔ **Not implemented / known limitation**

## Backend

| Area | Status | Notes |
| --- | --- | --- |
| API server (Bun + Express, SQLite) | ✅ | Boots, health, CORS, auth, rate limiting, audit log; **legacy pre-MQTT databases migrate instead of crashing at boot** (devices.external_id + index added by `migrate()` — regression-tested); Zod validation failures answer 400 VALIDATION instead of 500 + stack-trace dump |
| Auth (register/login/logout/session) | ✅ | **Full acceptance suite (22 auth tests)**: real registration (validated email, min-8 non-whitespace password, dup → 409), bcrypt hashing (`$2b$08$`, 60 chars, never stored plaintext), login with real hash verification (same 401 for unknown email vs wrong password — no enumeration), server-side sessions (token stored as SHA-256, expiry enforced, deleted on logout), `/auth/me` session restore (survives backend restart over the same DB file), protected routes (401 unauth / 200 auth), demo seed idempotent + real bcrypt user, no secrets in any response, DB-outage → generic `INTERNAL` error (no SQL/paths leaked), **rate limiting on `/login` (15/min) + `/register` (8/min) per IP**; `GET /api/auth/demo` reports demo availability (dev-only, hidden in production) |
| Farm & field CRUD | ✅ | GeoJSON validation, centroid/bbox/area computed server-side |
| Field isolation | ✅ | Every evidence/intelligence query is field-scoped and ownership-checked |
| Provider orchestrator | ✅ | request ids, timeouts, retry w/ backoff, health states, latency |
| Open-Meteo weather | ✅ | real calls; 190 evidence rows (current nowcast + 30d history + 7d forecast) with honest PREDICTED/HISTORICAL states |
| Real DEM terrain (OpenTopoData SRTM 90 m / ASTER 30 m) | ✅ | keyless real DEM grid sampled inside the field polygon (8 samples, mean 583.6 m, range 579–590 m); slope 2.2° / aspect 272° DERIVED via least-squares planar fit over the real samples (method recorded in evidence); falls back honestly to a single Open-Meteo centroid point (labelled CENTROID ELEVATION) only if DEM datasets are unreachable |
| Copernicus STAC discovery (Sentinel-2 + Sentinel-1) | ✅ | real STAC search over field AOI; **12 real products** (Sentinel-2 L2A + Sentinel-1 GRD SAR w/ VV/VH metadata) with footprints; discovery fixed — `landsat-c2-l2` is NOT hosted on Copernicus Data Space (404 → the old id 400'd the whole search), so Landsat is honestly excluded rather than faked |
| SoilGrids soil | 🟢 | real calls; REST service paused by ISRIC → **automatic WCS fallback** (`maps.isric.org`, keyless): the same SoilGrids v2.0 250 m model cells are pulled via WCS GetCoverage (EPSG:3857) over a ~3 km box around the field, decoded from GeoTIFF tiles and averaged → ESTIMATED evidence (verified live: ph 7.1, clay 442 g/kg, sand 225, silt 333, soc 15.8 g/kg, bdod 156 cg/cm³, cec 406 mmol/kg, nitrogen 19.6 g/kg for the Nashik demo field, units per ISRIC layer titles). Provider health stays truthful: AVAILABLE while the WCS path serves real data, `DATA_QUALITY_FAILURE` only when neither path returns usable cells (5xx → `DATA_QUALITY_FAILURE` classification kept); soil refresh cadence is a dedicated 6 h (`JOB_SOIL_SECONDS`) |
| Water intelligence (OSM open spatial + India-WRIS) | ✅ | **OpenStreetMap water features (Overpass API, keyless)** live: ~117 mapped features near seed field, nearest = Waghadi river at 0.695 km → DERIVED water evidence rows + world-model water layer `PARTIAL`; India-WRIS/CGWB stays 🔑 `NOT_CONFIGURED` — sources attempted & statuses shown |
| Sensor ingestion endpoint | ✅ | POST observations w/ dedupe + device heartbeat; device registered (NO_DATA until real gateway) |
| **MQTT subscriber (physical sensor activation)** | ✅ | `mqtt` subscriber in the API process: auto-reconnect, subscribes `AGRIFUR/field/+/device/+/telemetry` + `.../heartbeat`; server-side device→field resolution (topic field id never trusted); validation verdicts VALIDATED / SUSPECT / REJECTED / DUPLICATE (schema, device, timestamp window, per-sensor physical + calibration ranges); real Aedes-broker round-trip integration test; broker health as `mqtt-broker` provider (AVAILABLE / UNAVAILABLE / NOT_CONFIGURED) |
| **DEV HTTP hardware ingestion (ESP32 → HTTP, no MQTT)** | ✅ | `POST /api/dev/hardware/telemetry` — DEVELOPMENT-only: answers 404 unless `DEV_TELEMETRY_ENABLED=1` (+ optional `DEV_TELEMETRY_TOKEN` sent as `x-device-key`). Flat payload (`field_id`, `device_id`, `temperature_c`, `humidity_percent`, `soil_moisture_raw` raw ADC 0..4095, optional `observed_at`/`reading_id`) feeds the SAME shared pipeline as MQTT/gateway: physical-range validation (impossible → 400 `READING_REJECTED`), dedupe via `reading_id`, auto-registration of the device external id on the field, OBSERVED evidence rows with provenance, heartbeat, SSE event, world-model refresh. Malformed JSON → 400 `BAD_JSON`. 14 HTTP-level tests on a real server (incl. dedupe, SUSPECT handling, world-model sensor values). Reference firmware: `hardware/esp32/agrifur_esp32_http/agrifur_esp32_http.ino` |
| Device health (ONLINE/STALE/OFFLINE) | ✅ | computed from real `last_seen_at` (120 s / 900 s windows) — a device is never shown ONLINE forever after disconnecting |
| World model compose/snapshots/history | ✅ | verified live; diffable snapshot per trigger (SCHEDULED / MANUAL_ANALYZE) |
| Intelligence engines | ✅ | anomaly (sensor z-score, rainfall percentile), risk (heat/water/flood/sensor), uncertainty, contradiction — verified live against real evidence |
| Decision loop (ACTION → VERIFICATION → LEARNING) | ✅ | analyze writes evidence-linked actions (`/actions`); farmer sets `taken`/`verified`/`dismissed` via `/actions/:id/status` → `verifications` row (OBSERVED outcome) + farm-memory entry (verified live: 4 actions, verify stored, memory 17 entries) |
| Evidence relationships | ✅ | CONTRADICTS pairs mirrored into `evidence_relationships` w/ FK-guarded insert (skips non-evidence ids); `GET /evidence/relationships` + UI tab — populated when contradictions exist |
| Investigations + hypotheses | ✅ | open/enrich/auto-investigate, hypothesis status workflow (API verified) |
| Continuous-monitoring worker | ✅ | runs on startup + tick; jobs (WEATHER/SATELLITE/SOIL/TERRAIN/**WATER**/WM/INTEL) recorded; water every 12 h |
| Real-time events (SSE) | ✅ | event bus persists events; stream endpoint filters to user/field; sensor telemetry/heartbeat/world-model events trigger live UI refresh |
| Farm memory | ✅ | written only on real changes (verified: world-model changes, simulation run, farmer observation) |
| Assistant (grounded) | ✅ | local grounded fallback over real field evidence; LLM mode 🔑 needs `LLM_API_KEY` |
| Simulation (water balance) | ✅ | deterministic daily bucket; `SIMULATED` labels; verified run |
| Audit log | ✅ | boot/farm/field/device/auth/simulation events |

## Frontend (apps/web)

| Workspace | Status | Notes |
| --- | --- | --- |
| Landing page | ✅ | field-centric hero, pillars, 8-layer pipeline, CTA → auth |
| Auth (login/register + demo shortcut) | ✅ | returnTo preserved |
| App shell | ✅ | sidebar nav, field switcher, live indicator, SSE-driven badge |
| Interface languages | ✅ | English / हिन्दी / मराठी UI chrome (landing, shell, auth, world model cards, nav) via a persisted language switcher; data states keep canonical vocabulary; missing keys fall back to English |
| World model | ✅ | MapLibre map: field polygon/centroid, dark/light/sat basemap, acquisition footprints; domain cards with truthful states; camera refits on field switch; 2D/3D/Split controls |
| Weather / Water / Soil / Terrain / Crop workspaces | ✅ | dedicated routes (`/app/weather|water|soil|terrain|crop`) with provider health cards, world-model layer state, latest-per-variable metrics and evidence tables — NO_DATA/NOT_CONFIGURED/AUTH_REQUIRED states with reasons; Crop page can declare field crop metadata |
| History | ✅ | `/app/history`: world model versions, field-scoped event log, farm memory |
| Investigations | ✅ | `/app/investigations`: dedicated trigger → hypotheses → next-observation workspace |
| Evidence | ✅ | domain tabs + truth-state filters, expandable provenance rows |
| Intelligence | ✅ | risks/anomalies/uncertainty/contradictions + investigations UI |
| Satellite | ✅ | summary stats, timeline, product table w/ metadata + honest AUTH_REQUIRED states |
| Sensors | ✅ | device registry (stable firmware device id), computed ONLINE/STALE/OFFLINE badges, telemetry counts, MQTT broker state card, observation series with inline chart — updates live over SSE without refresh |
| AI assistant | ✅ | session list + grounded chat + mode labels |
| Voice input (assistant) | ✅ | **one-tap auto-voice**: tap → LISTENING → real Web-Audio RMS VAD (silence 1200 ms, min speech 500 ms, no-speech 15 s, max 60 s — tunable) auto-stops → STT (Web Speech API, en-IN/hi-IN/mr-IN following UI language) → auto-send through the grounded field pipeline → auto-TTS playback (Marathi/Hindi/English voice preferred) with IDLE/LISTENING/PROCESSING/ANSWERING/ERROR phases; no second Ask button in the voice path; typing stays as accessibility fallback; honest VOICE_UNSUPPORTED / mic-denied states; no audio leaves the device |
| Simulation | ✅ | scenario form + SIMULATED bar chart results |
| Notes & memory | ✅ | farmer observations + verify, farm memory + world model history |
| System | ✅ | provider health, jobs, events stream |
| Farms & fields | ✅ | draw-on-map polygon tool, **current-location (geolocation w/ permission-denied handling)**, **manual lat/lon + point/radius AOI (100 m–5 km + custom)**, GeoJSON paste, labelled DEVELOPMENT_SEED loader |
| Digital Twin 3D | ✅ | real field polygon ENU-projected XY-aligned with the 2D map; ground textured with the **real satellite/aerial basemap (ESRI World Imagery)** or map context beneath the twin (toggle, honestly labelled as context, not an acquisition); **ground surface displaced from real SRTM/ASTER DEM samples** (IDW interpolation of actual elevations, labelled DERIVED) when ≥4 samples exist, else honestly flat; **soil column rendered as a translucent slice below the surface** with depth ruler + NO_DATA/ESTIMATED state zones; **soil cutaway mode** lifts the map plane to inspect the slice; **thick explode stack** (soil → root zone → crops → sensors → intel) separating strictly in Y; **click-to-inspect picking** on real markers (risks/anomalies/investigations/sensors/acquisitions/field) with evidence panel; **bottom acquisition timeline** of real STAC products; orbit can pass below the surface slice; procedural crops MODELLED; no fake terrain/soil/sensors/water |
| Manual pipeline refresh | ✅ | `POST /api/fields/:id/refresh` runs the same backend path as the scheduler (weather → satellite → soil → terrain → **water (OSM)** → world model → intelligence) |
| Automated tests | ✅ | `bun test` — **102 passing**: GeoJSON Polygon/MultiPolygon typing & validation, provider error classification + health recording, evidence domain classification, field isolation, **terrain: grid sampling inside polygon, elevation stats, Horn slope/aspect, least-squares planar-fit fallback, honest UNKNOWN on sparse samples**, ai-context honesty + focus routing + field isolation (HTTP), **MQTT: topic parsing, validation verdicts (REJECT/SUSPECT/DUPLICATE), unknown device / wrong field / bad timestamp / bad range, heartbeat, evidence + AI-context propagation, device health, real Aedes-broker round-trip through the actual subscriber**, **DB migrations: legacy pre-MQTT database boots and gains external_id + index**, provider classification: 5xx → DATA_QUALITY_FAILURE, auth/rate-limit/timeout cases |

## Latest verified fixes

- **Soil**: SoilGrids REST is paused by ISRIC → automatic **WCS fallback** (`apps/api/src/providers/soilgridsWcs.ts`) serves the real v2.0 250 m model from `maps.isric.org` (EPSG:3857 coverages, GeoTIFF-cell decode, unit conversion per ISRIC layer titles). Verified live for the Nashik demo field: ph 7.1 · clay 442 · sand 225 · silt 333 g/kg · soc 15.8 g/kg · bdod 156 cg/cm³ · cec 406 mmol/kg · nitrogen 19.6 g/kg — 8 ESTIMATED evidence rows, `soilgrids=AVAILABLE` in provider health (probe falls back to WCS too).
- **Satellite UI**: “Fused acquisition overview” (per-platform counts, optical vs SAR, mean optical cloud) + per-product platform/product-type/polarization/field-intersection details + an honest “why AUTH_REQUIRED + how to unlock” card for raster previews (Copernicus OAuth env vars). Metadata remains real STAC; imagery is never faked.
- **Satellite per-field isolation (root-cause fix)**: `satellite_products.product_id` carried a **global UNIQUE** and both discovery paths deduped with `WHERE product_id = ?` (no field filter). Because a Sentinel scene legitimately covers many fields, the first field that stored a scene blocked every later field under the same scene — additional fields showed a permanently empty catalog (repro: demo “south” field returned 0 while direct STAC over its bbox returned the same 12 acquisitions). Fixes: schema drops the global UNIQUE, adds `idx_sat_field_product(field_id, product_id)`; `db/index.ts` gains an idempotent boot migration that rebuilds a legacy table (rename → recreate → copy deduped per field → drop); both insert paths (`refreshSatellite` in `pipeline.ts` and the `/satellite/search` route) dedupe per `field_id+product_id` and mint field-scoped row ids (`sat_<product>_<field8>`). Verified live: second field discovery now records its own 12 products, first field untouched, row ids distinct per field. The Satellite page additionally auto-runs one idempotent discovery per empty-field visit so a never-discovered field stops showing a false-empty catalog.
- **Risk engine logic fix (water stress)**: the ET0/precipitation balance rule could silently downgrade a soil-moisture-driven elevation back to LOW (`balance >= 0 → level = LOW` ran after the sensor branch, letting the proxy override the sensor). Soil moisture is now authoritative when present (dry soil stays at least MEDIUM regardless of recent balance), with LOW only when moisture is healthy or no deficit exists, and UNKNOWN only when there is no sensor and no deficit. Verified live: north field water_stress=MEDIUM citing 7 evidence rows (`evidence_ids` populated).
- **Field selection auto-repair**: the app never validated the stored `agrifur_active_field` id against the logged-in user's owned fields, so a stale id (previous user / deleted field / first login) left `activeField` null — the selector rendered blank and every workspace gated on “select a field” even though fields existed. `AppProvider` now falls back to the first owned field whenever the stored id is missing or not owned.
- **Continuous pipeline (no manual analyse)**: creating a field now auto-fires the full evidence pipeline (`POST /api/fields/:id/refresh`: weather → satellite → soil → terrain → water → world model → intelligence) immediately after creation, and the World workspace auto-kicks it once per field per session when a field has no world model yet. Verified live: a freshly created field went from empty to `weather PARTIAL(190) · satellite PARTIAL(12) · soil PARTIAL(8) · terrain PARTIAL(16) · water PARTIAL(2)` without a single manual click.
- **Digital Twin full-scene mode**: new `⛶ Full scene` toggle fills the screen with the 3D scene (page header + control/timeline panels hide; a floating ✕ exit button stays on top), canvas height grows to `calc(100dvh - 18px)` and the 3D renderer auto-resizes via its ResizeObserver; default (non-cinema) canvas is also taller (`calc(100vh - 178px)`). Field switching, layer toggles and split view remain available in the sidebar.
- **Digital Twin exploded stack rebuilt (thick ordered slabs)**: the exploded view previously lifted paper-thin slices (2.6 m soil / 0.7 m roots on a ~100 m field) with uneven, even colliding offsets (intel markers lifted between roots and crops). The stack is now a set of thick, ordered slabs — 1 FIELD → 2 SOIL (12 m display-thick) → 3 ROOTS (4 m) → 4 CROPS (plants ~2× display scale on an always-visible stand) → 5 SENSORS → 6 SATELLITE → 7 INTELLIGENCE (each thin layer gains a 1.6 m slab chip that only appears while exploded, so the collapsed twin stays clean); lifts are cumulative with even gaps so slabs never collide; markers are bigger (spheres 2.1, risk tetrahedra 2.6, acquisition spheres 1.7–2, investigation octahedra 2.8) and sit on top of their slab; every label is numbered + tagged DISPLAY SCALE; the view pans up as the stack grows so layers never leave frame; explode defaults to 45% so the one-above-the-other structure is visible immediately. XY stays true to the field geometry; honesty notes retained.
- **Simulation**: engine verified live (create → run → persisted output). Demo field now ships one pre-run `Kharif monsoon water balance (DEVELOPMENT_SEED)` scenario so the workspace is not empty; the page restores the latest run output of every scenario after reload (outputs previously vanished on refresh).
- **Simulation v1.1 (climate-anchored + auto-starter)**: the engine previously ran only uniform daily inputs against a hardcoded ET0 default (5 mm). It now supports `et0_source: "field_climate"` — the daily rain/ET0 baseline is taken from the field's **real recorded ET0/precipitation weather evidence** (most recent N model days; user inputs become fallback + irrigation), output labelled SIMULATED with a `climate.days_used/note` trace. Any field that has real ET0 evidence but zero scenarios now auto-creates and auto-runs ONE clearly-labelled `Field climate water balance (auto · DEVELOPMENT_SEED)` starter on first open (idempotent per field), so the Simulation workspace never opens empty — verified live: demo “south” field opened empty → now has a completed 30-day climate-baseline run (−50.9 mm end balance) with per-day values from real evidence. The page gains a “Use this field’s real recent climate” toggle and shows the baseline badge (field climate vs uniform) on each output.
- **Assistant**: verified live — grounded answers with cited evidence in `LOCAL_GROUNDED_FALLBACK` mode (12 evidence refs) without an LLM key; LLM mode activates automatically when `LLM_API_KEY`/`LLM_BASE_URL`/`LLM_MODEL` are set.

## Known limitations (honest)

- SQLite (bun:sqlite) is the runtime DB; production PostGIS SQL is provided as reference, not executed here.
- SoilGrids REST is paused by ISRIC; the **WCS fallback** (`apps/api/src/providers/soilgridsWcs.ts`) serves real 250 m
  model cells from `maps.isric.org` when the grid has coverage there (verified live for the Nashik demo field). Where
  the grid really has no valid cells the layer reports the honest gap; values are always `ESTIMATED` model data, never
  field measurements.
- Water layer: credential-free national Indian hydrology (India-WRIS/CGWB) needs account access → `NOT_CONFIGURED`; surface-water context now comes live from the OpenStreetMap open spatial dataset (Overpass), honestly labelled DERIVED/mapped-features (not gauge observations). Groundwater/aquifer depth remains UNKNOWN by design.
- Overpass availability depends on public mirrors; the adapter fails over across official mirrors and records the attempted sources when all are unreachable.
- Water feature mapping is as complete as OSM is for the area (vectors, not gauges) — no waterbody depth/flow is implied.
- Raster previews of Sentinel products require Copernicus OAuth; UI shows `AUTH_REQUIRED` rather than fake imagery.
- Landsat is not hosted on Copernicus Data Space STAC (all `landsat-*` ids 404); a real Landsat integration needs USGS/another provider adapter (AUTH_REQUIRED path) — no Landsat product is faked.
- Sensor telemetry: no physical gateway exists in this cloud environment — devices show registered/WAITING_FOR_TELEMETRY honestly. MQTT activation is implemented and verified with a real in-process broker; the physical ESP32 + LAN Mosquitto test must run on the developer's Windows machine (see `docs/MQTT_HARDWARE.md`) — `HARDWARE_NOT_CONNECTED` / `MQTT_UNAVAILABLE` are the truthful states here. The **simplest LAN path is the dev HTTP endpoint** (`POST /api/dev/hardware/telemetry`, firmware in `hardware/esp32/agrifur_esp32_http/`) — start the backend with `DEV_TELEMETRY_ENABLED=1` on the developer's machine (e.g. `PORT=3001`) and the ESP32 posts real DHT11 + raw soil-moisture ADC values straight into the same OBSERVED evidence pipeline.
- Heat-stress/water-stress risk is only as good as the (model) weather evidence and connected sensors; levels are
  qualitative and reasons cite the exact evidence used.
- LLM assistant mode needs an API key; local grounded fallback is the default.
- Auth uses server-side bearer sessions (token stored SHA-256-hashed in SQLite, `SESSION_TTL_HOURS` default 720 h). The existing architecture is token-based (Authorization header, SSE-compatible) — not HttpOnly cookies; tokens live in localStorage, so XSS is the residual threat model (no XSS sinks found in the app; production hardening could move to HttpOnly cookies).
- Rate limiting is in-process per API instance (development-grade; a multi-instance deployment should share a store).
- Terrain: slope/aspect come from a planar fit or Horn finite differences over the real SRTM/ASTER samples (field-scale gradients, not sub-metre survey). When fewer than 4 samples fall inside the field, slope/aspect honestly stay UNKNOWN.
- Twin water layer stays gated on the mapped-feature evidence (OSM vectors near the field can render once a field has them); no water volume is fabricated.
- Where the 250 m grid has gaps the twin soil volume renders as an explicitly-labelled NO_DATA/partial zone; ESTIMATED
  property rendering activates automatically from the WCS fallback when usable cells exist.
- Twin crop/plant geometry is procedural and labelled MODELLED (no measured plant geometry exists).

- The simulation plane beyond the 2D water-balance model is not yet extended to 3D what-if scene previews.

## Final audit pass (latest verification round)

Verified against the running preview with `scripts/verify_final.mjs` — **44/44 live checks**:

- **Field isolation proven with two real accounts**: a second registered user sees zero demo fields, gets `403 FORBIDDEN`
  on demo's world-model/evidence/devices/ai-context/digital-twin, and the demo user gets `403` on the second user's
  field. Field creation validates GeoJSON server-side (Polygon ring closed, coordinates finite/in-range, area computed).
- **Realtime ownership isolation fixed & proven**: the SSE stream previously fanned every event to every authenticated
  client. The handler now drops events that do not belong to the viewer (`user_id` boundary; admins see all) and
  ownership-checks the `field_id` filter param (foreign field → 403). Live proof: user A's stream received only its own
  `SENSOR_TELEMETRY` while user B ingested telemetry in the same window, and vice versa.
- **Telemetry pipeline exercised live over HTTPS**: register device → ingest 3 real readings (`inserted:3`) → duplicate
  `ingestion_id` skipped → out-of-range value rejected (`rejected:1`) → unknown device `404` → malformed payload `400
  VALIDATION` → OBSERVED evidence promoted with provenance → world model sensor layer `PARTIAL(1)` → twin sensors layer
  `OBSERVED`.
- **Satellite truthfulness**: summary note no longer claims Landsat data; manual STAC search rejects a landsat-only
  request (`400`) and silently drops `landsat-c2-l2` from mixed requests (never sent to the CDSE endpoint — it 404s
  there); indices endpoint honestly reports `AUTH_REQUIRED` with zero fabricated NDVI.
- **Worker cadence truthfulness**: `/api/system/status` now reports `soil_interval_seconds` from the real dedicated
  6 h soil config (was incorrectly echoing the world-model interval).
- **Landing page truthfulness**: the “Sentinel-2 · Sentinel-1 · Landsat” pill and the pillar copy no longer imply live
  Landsat; they now state Sentinel-2/Sentinel-1 STAC discovery and that Landsat needs a credential-gated USGS adapter.
- Engines, assistant (LOCAL_GROUNDED_FALLBACK without LLM key, evidence refs + uncertainty attached), providers
  (copernicus=AVAILABLE · soilgrids=AVAILABLE via WCS fallback · mqtt-broker=NOT_CONFIGURED · llm=AUTH_REQUIRED), twin
  layers, AI context (field-scoped + focus routing + 403 cross-user) — all green.

## Anti-fabrication audit (searched patterns)

`mock`, `dummy`, `placeholder imagery`, `Math.random`-based telemetry, hardcoded risk/confidence/telemetry values,
Unsplash/satellite stock URLs, `"connected"/"94%"`-style claims — none found in production paths. Seeded demo data is
explicitly named `DEVELOPMENT_SEED`; simulation output is state `SIMULATED` with a disclaimer on every run.
