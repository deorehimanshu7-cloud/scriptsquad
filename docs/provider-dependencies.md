# AGRIFUR2 — Provider Dependency Matrix

Status vocabulary (never claimed without a real check):

- **IMPLEMENTED** — adapter code exists and is wired through the provider
  orchestrator.
- **VERIFIED** — a real request succeeded against the live service in this
  build cycle.
- **NO_DATA** — service reachable but returned no records for the AOI/window.
- **AUTH_REQUIRED** — adapter is real; credentials are not configured.
- **WAITING_FOR_DEVICE** — implementation ready; physical hardware not connected.
- **CONFIGURED** — environment variables present and accepted by the service.

| Provider | Purpose | Endpoint(s) | Auth required | Env variables | Implemented | Configured | Live verified | Data state | Failure state |
|---|---|---|---|---|---|---|---|---|---|
| Copernicus Data Space STAC | Sentinel-2 L2A discovery | `https://stac.dataspace.copernicus.eu/v1/` | No (catalog); OAuth for asset download | `COPERNICUS_CLIENT_ID`, `COPERNICUS_CLIENT_SECRET` | YES | NO | YES (search) | VERIFIED / NO_DATA per AOI | `AUTH_REQUIRED` for band assets; provider errors truthful |
| Sentinel-1 (via CDSE STAC) | SAR product discovery | same STAC (`sentinel-1-grd` etc.) | No (catalog) | same as Copernicus | YES | NO | NO (not exercised this cycle) | NO_DATA / AUTH_REQUIRED | `PROVIDER_ERROR`, `TIMEOUT` |
| Landsat C2 (USGS earth-search STAC) | Landsat 8/9 L2 discovery | `https://earth-search.aws.element84.com/v1/` | No | — | YES | YES | YES | VERIFIED (LC08/LC09 records stored) | truthful statuses |
| Bhoonidhi / NRSC | Indian EO (EOS-04/06, CartoSat, ResourceSat…) | `https://bhoonidhi-api.nrsc.gov.in/` (`/auth/token`, `/data/search`, `/download`) | YES | `BHOONIDHI_USER_ID`, `BHOONIDHI_PASSWORD` | YES (adapter contract) | NO | NO | AUTH_REQUIRED | token/rate-limit (401/429) mapped |
| Open-Meteo | Weather current/forecast/history + elevation | `https://api.open-meteo.com/v1/` | No | — | YES | YES | YES | VERIFIED (MODEL_DERIVED / PREDICTED / REANALYSIS) | truthful |
| Open-Meteo elevation | DEM terrain | same host `/v1/elevation` | No | — | YES | YES | YES | VERIFIED (DERIVED, e.g. 518 m) | NO_DATA when no sample |
| SoilGrids v2 (ISRIC) | Soil properties (ESTIMATED) | `https://rest.isric.org/soilgrids/v2.0/` | No | — | YES | YES | YES | VERIFIED (ESTIMATED per-depth) | per-property retries; partial success |
| Water (CGWB / India-WRIS) | Groundwater / surface context | official portals (dataset-gated) | YES | future provider creds | YES (truthful adapter) | NO | NO | UNKNOWN / NO_DATA | never fabricated depth |
| MQTT broker (EMQX) | Live sensor transport | `mqtt(s)://` | YES | `MQTT_BROKER_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `MQTT_TLS` | YES | NO (no broker/device in sandbox) | NO | WAITING_FOR_DEVICE | broker absent → `UNAVAILABLE`; HTTPS telemetry works |
| HTTPS telemetry | Device fallback transport | `/api/devices/:id/telemetry` | device key | n/a | YES | YES | YES | VERIFIED (OBSERVED observations) | 401 invalid key |
| LLM (OpenAI-compatible) | AI reasoning over field context | provider base URL | YES | `LLM_API_KEY`, `LLM_MODEL`, `LLM_BASE_URL` | YES | NO | NO | AUTH_REQUIRED | local grounded engine answers without key |
| Storage (MinIO/S3) | raster/asset persistence | S3-compatible | YES | `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` | YES (docker compose) | NO | NO | NOT_CONFIGURED | truthful |
| Redis / BullMQ | queue / jobs | redis:// | optional | `REDIS_URL` | YES (docker compose) | NO | NO | NOT_CONFIGURED | jobs run in-process fallback |
| MapLibre basemap (Carto Positron) | 2D map context | `https://basemaps.cartocdn.com/gl/positron-gl-style/style.json` | No | optional `MAP_PROVIDER_KEY` | YES | YES | YES | VERIFIED | basemap offline → field polygon still renders |
| Esri World Imagery | Digital Twin real imagery base | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` | No | — | YES | YES | YES | VERIFIED (tile shown, OBSERVED) | offline → relief surface + `Imagery: UNAVAILABLE` note |

## Notes on truthfulness

- Weather **current** is `MODEL_DERIVED`, **forecast** `PREDICTED`, ERA5
  **history** `REANALYSIS` — none are labelled as physical observations.
- SoilGrids values are **ESTIMATED** (model predictions with uncertainty), never
  `OBSERVED`. pH/EC show `UNKNOWN` unless a validated observation exists.
- Satellite records are **OBSERVED** catalog metadata; band-level indices
  (NDVI/NDMI…) require authenticated asset download → `AUTH_REQUIRED` until
  `COPERNICUS_CLIENT_ID/_SECRET` are configured.
- Sensor observations are `OBSERVED` only when a real device message passed
  validation; otherwise the UI shows `NO_DATA`.
