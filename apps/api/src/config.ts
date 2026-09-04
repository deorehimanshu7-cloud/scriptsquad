import path from "node:path";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}
function envInt(name: string, fallback: number): number {
  const v = parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

export const config = {
  port: envInt("PORT", 8787),
  publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8787"),
  databasePath: env("DATABASE_PATH") || path.resolve(import.meta.dir, "..", "data", "agrifur.db"),
  sessionTtlHours: envInt("SESSION_TTL_HOURS", 720),
  allowedRegisterEmails: env("ALLOWED_REGISTER_EMAILS", "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  // providers
  openMeteoBaseUrl: env("OPEN_METEO_BASE_URL", "https://api.open-meteo.com/v1"),
  openTopoDataBaseUrl: env("OPENTOPODATA_BASE_URL", "https://api.opentopodata.org"),
  copernicusStacUrl: env("COPERNICUS_STAC_URL", "https://stac.dataspace.copernicus.eu/v1"),
  copernicusTokenUrl:
    env("COPERNICUS_TOKEN_URL", "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"),
  copernicusClientId: env("COPERNICUS_CLIENT_ID"),
  copernicusClientSecret: env("COPERNICUS_CLIENT_SECRET"),
  soilgridsBaseUrl: env("SOILGRIDS_BASE_URL", "https://rest.isric.org/soilgrids/v2.0"),
  bhoonidhi: {
    tokenUrl: env("BHOONIDHI_TOKEN_URL"),
    apiUrl: env("BHOONIDHI_API_URL"),
    clientId: env("BHOONIDHI_CLIENT_ID"),
    clientSecret: env("BHOONIDHI_CLIENT_SECRET"),
  },
  llm: {
    apiKey: env("LLM_API_KEY"),
    baseUrl: env("LLM_BASE_URL", "https://api.openai.com/v1"),
    model: env("LLM_MODEL", "gpt-4o-mini"),
  },

  // MQTT — physical sensor activation. The broker lives on the development
  // LAN (Mosquitto, port 1883). The broker URL must be reachable from the API
  // process; for the ESP32 it must be the Windows machine's LAN IPv4 (never
  // localhost/127.0.0.1 on the device). The subscriber only starts when a
  // broker URL is explicitly configured (or MQTT_ENABLED=1), so an unconfigured
  // environment honestly reports NOT_CONFIGURED instead of retrying forever.
  mqtt: {
    enabled:
      env("MQTT_ENABLED", "") === ""
        ? env("MQTT_BROKER_URL", "") !== ""
        : env("MQTT_ENABLED", "") === "1",
    brokerUrl: env("MQTT_BROKER_URL", "mqtt://127.0.0.1:1883"),
    username: env("MQTT_USERNAME", "") || undefined,
    password: env("MQTT_PASSWORD", "") || undefined,
    topicPrefix: env("MQTT_TOPIC_PREFIX", "AGRIFUR"),
    reconnectPeriodMs: envInt("MQTT_RECONNECT_PERIOD_MS", 5000),
    connectTimeoutMs: envInt("MQTT_CONNECT_TIMEOUT_MS", 10_000),
    /** last_seen within this window → ONLINE (seconds) */
    deviceOnlineWindowSec: envInt("MQTT_DEVICE_ONLINE_WINDOW_SEC", 120),
    /** last_seen within this window → STALE; older → OFFLINE (seconds) */
    deviceStaleWindowSec: envInt("MQTT_DEVICE_STALE_WINDOW_SEC", 900),
    /** throttle world-model recomposition per field (ms) */
    worldModelThrottleMs: envInt("MQTT_WORLD_MODEL_THROTTLE_MS", 60_000),
  },

  // static frontend build (served by this API process when present)
  webDistDir: env("WEB_DIST_DIR", path.resolve(import.meta.dir, "..", "..", "web", "dist")),
  seedDemoOnBoot: env("SEED_DEMO_ON_BOOT", "1") === "1",
  /** development demo account (created by the idempotent seed) */
  demoEmail: env("DEMO_EMAIL", "demo@agrifur.dev"),

  // cadence seconds
  jobWeatherSeconds: envInt("JOB_WEATHER_SECONDS", 1800),
  jobSatelliteSeconds: envInt("JOB_SATELLITE_SECONDS", 6 * 3600),
  jobSoilSeconds: envInt("JOB_SOIL_SECONDS", 6 * 3600),
  jobWorldModelSeconds: envInt("JOB_WORLD_MODEL_SECONDS", 600),
  jobIntelligenceSeconds: envInt("JOB_INTELLIGENCE_SECONDS", 600),
  jobProviderHealthSeconds: envInt("JOB_PROVIDER_HEALTH_SECONDS", 900),
  workerTickMs: 15_000,
  /** useful for demos: shorten the "new acquisition" window on STAC searches */
  satelliteSearchDaysBack: envInt("SATELLITE_SEARCH_DAYS", 30),
} as const;

export type AppConfig = typeof config;
