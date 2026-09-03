# AGRIFUR2 — Implementation Status

> Replaces the earlier prototype-shell audit. Current snapshot: September 2026.

## Working end-to-end (verified live)

- **Backend** (Express + TypeScript) with a two-driver data layer:
  - `DATABASE_MODE=postgres` → PostgreSQL + PostGIS 16, canonical/production.
    Field metrics and predicates are computed by PostGIS
    (`ST_Area` on projected CRS, `ST_Perimeter`, `ST_Centroid`,
    `ST_Intersects`/`ST_Within`/`ST_Contains`/`ST_DWithin`, SRID 4326).
  - `DATABASE_MODE=sqlite-dev` → labelled development fallback (fresh
    `backend/agrifur2.db`); geometry metrics computed by shared geodesic
    utilities and flagged `metrics_computed_by: sqlite-dev-geo`. Never claimed
    as PostGIS.
- **Frontend** (React + Vite + TypeScript): 2D MapLibre World, 3D Digital Twin
  (Three.js/R3F on real field geometry), and workspaces for Intelligence,
  Evidence, Investigations, Satellite (real Copernicus/Landsat STAC search),
  Sensors (device keys + telemetry), Weather (Open-Meteo), Environment
  (soil/terrain/water/crop), History, Simulation, AI Assistant, System/health.
- **Evidence pipeline** persists field-scoped evidence with state, provenance,
  quality (`NOT_ASSESSED` unless computed) and feeds the World Model;
  anomaly/risk/uncertainty/contradiction engines run on that evidence only.
- **Live provider results during verification**: Open-Meteo weather
  (`MODEL_DERIVED`), Copernicus STAC Sentinel-2 real product
  (`OBSERVED`, product `S2C_MSIL2A_...`), SoilGrids estimates (`ESTIMATED`,
  e.g. clay 36.2 %, pH 7.0, CEC 28.8 cmol(c)/kg with provenance),
  DEM elevation 518 m (`DERIVED`).
- **AI Assistant**: field-scoped sessions; without `AI_API_KEY` a local
  grounded engine answers only from stored evidence (tool calls, evidence
  refs, no invented measurements).

## Verification performed

- Backend build clean; frontend production build clean.
- Jest: 18 unit/integration tests pass (geometry, field lifecycle, field
  isolation, engines truthfulness incl. no `confidence` scalars, pipeline
  offline safety); PostGIS-gated suite skips truthfully without PostgreSQL.
- Live E2E (`scripts/e2e-live.mjs`): 37/37 checks — auth → farm → field
  (real geometry, area 117.23 ha labelled sqlite-dev-geo) → weather (real) →
  satellite (real STAC product) → analyze (anomalies/risks, uncertainty
  `NOT_ASSESSED`) → world model → investigation → NBO → grounded AI.

## Hardware + edge voice (this phase)

**CODE IMPLEMENTED + INTEGRATION VERIFIED (HTTP path).** New tables
`telemetry_raw`, `device_heartbeats`, `device_events`, `commands` (plus
`method`/`valid_until` on calibrations) in the PostGIS migration and the
sqlite-dev mirror. Shared ingest pipeline preserves raw payloads
(RECEIVED → VALIDATED/SUSPECT/REJECTED/DUPLICATE), validates ranges/timestamps,
dedupes by `(device_id, message_id)`, resolves deployments server-side and
stores each valid physical reading as an observation **and** OBSERVED evidence
so engines and the World Model see hardware. Device state
(ONLINE/STALE/OFFLINE/MAINTENANCE/ERROR/UNKNOWN) is derived from real
heartbeats with a 120 s staleness window — never hardcoded.

New endpoints: `devices` register/list/detail/patch/status/heartbeat/telemetry/
sync/commands/acks/events; `sensors/:id` status/calibrations/patch;
`fields/:id/hardware-health`; `voice-devices` register/heartbeat/sync/status
(offline cache with real `observed_at` timestamps). Downlink commands are
whitelisted; actuator commands require `AGRIFUR2_ENABLE_ACTUATORS=true`.
Assistant tools extended: `getSensors` (enhanced), `getDeviceStatus`,
`getSensorHistory`, `getCalibration`; the LLM path now receives retrieved
tool context. AI assistant UI was rewired to the real sessions/messages API
(previously pointed at a non-existent route) and gained push-to-talk voice
states. Digital Twin renders only genuinely-positioned deployed devices.
ESP32 reference firmware under `firmware/` (CODE IMPLEMENTED — requires real
hardware: HARDWARE_NOT_CONNECTED).

Verification: 9 new jest tests (hardware suite) + 27 total pass; live HTTP E2E
`scripts/e2e-hardware.mjs` 28/28 (telemetry, dedupe replay, calibration,
commands whitelist, heartbeat-derived ONLINE, hardware-health, voice sync,
sensor-aware AI); core E2E 37/37 still green. MQTT transport is implemented in
`mqtt-client` but not exercised live (no broker in sandbox).

## SIH execution pass (UI + truthfulness + isolation)

**Bright agricultural theme.** The whole workspace was inverted from the dark
slate UI to a clean light theme by remapping the Tailwind slate scale (page
`#f8fafc`, panels white/light-gray, dark readable text) and darkening the
lightest status text shades for contrast on white. MapLibre World basemap is
now Carto Positron (light). Header/sidebar/panel/workspace colors, login,
popups and scrollbars all follow. Verified in-browser on World, Digital Twin
and Sensors.

**NaN% Evidence Coverage fixed (root cause).** The backend replaced the old
numeric `evidenceCoverage` with a labelled coverage descriptor, but World and
Intelligence pages still multiplied the now-undefined field → `NaN%`. Both
pages now render the real descriptor: `EVIDENCE_COVERAGE` label, total evidence
count, and per-domain AVAILABLE/MISSING chips — explicitly labelled "never a
confidence percentage". No page multiplies an undefined coverage value
anymore (grep-verified).

**Truthful numbers everywhere.** Risk-card uncertainty now renders the real
`NOT_ASSESSED` string instead of `NaN%`; Evidence-page quality shows
`NOT_ASSESSED` when no numeric quality assessment exists instead of a fake
`0%`; System providers show the measured success rate only when real
(`success_rate_measured`, otherwise `NOT MEASURED`) and latency only when
present; field area cards show `AREA UNKNOWN` instead of `0.00 hectares` when
no valid geometry-derived area exists.

**Field isolation hardened.** Every workspace now clears its state the moment
`currentField` changes before fetching the new field's data (World, Digital
Twin, Satellite, Sensors, Evidence, Intelligence, Investigations, History;
Weather/Environment already did). No stale cross-field data can flash or
linger. Digital Twin fetches World Model, devices and latest observations per
field and resets on switch.

**Realtime.** World and Digital Twin subscribe to the backend SSE stream
(`/api/system/events/stream`) and refetch on `OBSERVATION_RECEIVED`,
`SENSOR_CONNECTED`, `WORLD_MODEL_UPDATED` for the *selected* field — live
sensor observations now appear in the UI and Twin without a manual refresh.

**Soil → evidence pipeline fixed.** `fetchAndStoreSoil` stored
`soil_observations` rows but never created evidence, so soil was `AVAILABLE`
in the State panel yet `MISSING` in coverage and invisible to evidence-driven
engines. It now inserts one ESTIMATED evidence row per stored property, and
World-Model coverage derives each domain from the same store the State panel
reads — coverage and state can no longer disagree. Verified live:
`coverage.domains.soil: AVAILABLE` with 9 real SoilGrids properties.

**i18n.** Added missing `nav.environment` label to en/hi/mr (was rendering as
the raw key in the sidebar).

Verification this pass: backend Jest 27 passed / 2 PostGIS-gated skipped;
frontend `tsc` + production build clean; live E2E 37/37; hardware E2E 28/28;
SSE stream verified; bright theme + Digital Twin + Sensors pages verified in
browser.

## Final 4-hour pass (satellite workspace + real-imagery Twin + docs)

**Digital Twin — real imagery base.** The flat brown relief plane is now
underlaid with a REAL Esri World Imagery tile covering the field bbox, placed
with the exact degree→scene transform used by the field boundary, crops and
sensors, so everything stays geographically aligned (north-up; the terrain
fill rotation bug that mirrored the polygon was also fixed). If the tile cannot
load (offline demo venue), the scene truthfully reports `Imagery:
UNAVAILABLE — relief surface only` in the Field info card — no fake texture is
substituted. Verified in-browser: the yashwant nagar field renders as a green
outlined plot over the real aerial imagery, with the OBSERVED chip.

**Satellite workspace — LATEST vs BEST QUALIFIED + per-source separation.**
The LATEST tab now auto-persists real acquisitions for the AOI when none are
stored, then shows two honest cards: LATEST ACQUISITION (newest over the AOI)
and BEST QUALIFIED PRODUCT (lowest cloud cover in window), each with product
ID / collection / provider / acquisition / cloud / platform metadata, and a
"By real source" section listing each mission separately (Sentinel-2 vs
Landsat C2 — sources are never merged into a fake fused image). Visual assets
are truthfully labelled "Metadata available · Asset unavailable for preview
(band assets require provider authentication)". Verified live on the demo
field: LATEST `LC08_L2SP_…` 2026-07-27 cloud 20.35%; BEST `LC09_L2SP_…`
2026-07-19 cloud 2.32%; Sentinel-2 honestly reported as no data for this AOI.

**Docs.** `docs/provider-dependencies.md` added with the full provider
matrix, real endpoint URLs, env variables, and per-provider states
(IMPLEMENTED / VERIFIED / NO_DATA / AUTH_REQUIRED / WAITING_FOR_DEVICE).

Verification this pass: frontend `tsc` + production build clean; in-browser
verification of the Twin (imagery AVAILABLE) and Satellite (LATEST/BEST)
against the live backend; all earlier suites still green (27 jest, 37 live
E2E, 28 hardware E2E).

## Final spatial-first pass (World workspace + Twin view + Satellite)

**World page → full-viewport spatial workspace (not a card dashboard).** The map
now fills the screen; the field identity card floats top-left (real area,
footprint/device/risk counts, live `map online` / `BASEMAP UNAVAILABLE` chip);
the right side is a translucent contextual Intelligence panel; the bottom is a
click-to-zoom EVIDENCE TIMELINE built from real evidence. Real spatial
overlays render on the map from stored data only: satellite acquisition
footprints (purple dashed outlines, from EARTH_OBSERVATION evidence geometry),
genuinely-positioned devices (cyan) and field-scope risks (red at the real
field centroid). Basemap robustness: the app probes the Positron style before
starting the map and falls back to a minimal local style so the real field
polygon ALWAYS renders — if the external provider is unreachable the chip
honestly says BASEMAP UNAVAILABLE. Verified in-browser: 3 footprints + 1 risk
on the map, timeline streaming real evidence, coverage 19.

**Digital Twin — whole-geographic-context framing.** Camera distance and
orbit limits are now derived from the real field extent, so you can zoom out
to the full surrounding geography and in to the field; Fit Field / Fit World /
Reset buttons fly the camera (the scene's geographic XY is unchanged — explode
remains a pure Z visual offset, stated in the UI). Verified via typecheck +
build; imagery layer from the previous pass still reports OBSERVED.

**Satellite workspace polish.** Latest/Best cards and per-source grouping now
use the bright theme's dark-on-light text (headings rgb(30,41,59) verified).
LATEST vs BEST QUALIFIED shown from stored real Landsat records; Sentinel-2
reported truthfully as no data for the demo AOI.

Verification this pass: frontend `tsc` + production build clean; backend Jest
27 passed / 2 PostGIS-gated skipped (unchanged); in-browser DOM checks for
World (footprints/timeline/panel), Twin (imagery AVAILABLE), Satellite
(LATEST/BEST) against the live sqlite-dev backend.

## Final spatial-first pass (World workspace + Twin view + Satellite)

**World page → full-viewport spatial workspace (not a card dashboard).** The map
now fills the screen; the field identity card floats top-left (real area,
footprint/device/risk counts, live `map online` / `BASEMAP UNAVAILABLE` chip);
the right side is a translucent contextual Intelligence panel; the bottom is a
click-to-zoom EVIDENCE TIMELINE built from real evidence. Real spatial
overlays render on the map from stored data only: satellite acquisition
footprints (purple dashed outlines, from EARTH_OBSERVATION evidence geometry),
genuinely-positioned devices (cyan) and field-scope risks (red at the real
field centroid). Basemap robustness: the app probes the Positron style before
starting the map and falls back to a minimal local style so the real field
polygon ALWAYS renders — if the external provider is unreachable the chip
honestly says BASEMAP UNAVAILABLE. Verified in-browser: 3 footprints + 1 risk
on the map, timeline streaming real evidence, coverage 19.

**Satellite workspace → spatial explorer.** Restructured into a three-part
geographic layout (responsive): a Sources column that keeps missions separate
(Sentinel-2 `1 stored`, Sentinel-1 `NO_DATA`, Landsat `2 stored`, Bhoonidhi
`AUTH_REQUIRED` — never merged into a fake fused image), a CENTER geographic
viewer that renders the real field AOI plus each stored acquisition's real
catalog footprint over map tiles (map initializes only when the container is
actually mounted — fixed; click a timeline product to select & fly to it), and
a Product inspector showing real metadata (product ID, collection, provider,
acquisition, cloud %, platform, asset count) with an explicit
`PREVIEW UNAVAILABLE — authenticated band access required` state. The
acquisition timeline sits below with the real stored products (LC08 cloud
20.35%, LC09 cloud 2.32%, S2A cloud 28.55%). Verified in-browser.

**Digital Twin — whole-geographic-context framing.** Camera distance and
orbit limits are derived from the real field extent, so you can zoom out to
the full surrounding geography and in to the field; Fit Field / Fit World /
Reset buttons fly the camera (geographic XY unchanged — explode is a pure Z
visual offset, stated in the UI). Verified via build + DOM; imagery layer
reports OBSERVED.

Verification this pass: frontend `tsc` + production build clean; backend Jest
27 passed / 2 PostGIS-gated skipped (unchanged); in-browser DOM checks for
World, Twin and Satellite explorer against the live sqlite-dev backend.

## Honest limitations

- **SoilGrids** answers ~90 s for ten per-property queries (multi-property
  requests return HTTP 500 upstream; adapter retries with partial-success
  reporting).
- **Water** (CGWB / India-WRIS) and **Bhoonidhi** remain credential-gated:
  `NO_DATA` / `AUTH_REQUIRED`, never fabricated.
- **Band-level indices** (NDVI/NDMI, change detection) require authenticated
  asset download → truthful `AUTH_REQUIRED` until credentials are configured.
- Sandbox had no Docker/PostgreSQL: PostGIS path is implemented and
  integration-tested via the gated suite, but was not executed against a live
  instance here.

See `README.md` for run commands, provider matrix and environment template.
