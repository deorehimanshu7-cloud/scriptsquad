import { config } from "../config";
import { fetchJson } from "./orchestrator";

export interface DailyRow {
  date: string; // yyyy-mm-dd
  temperature_2m_max: number | null;
  temperature_2m_min: number | null;
  temperature_2m_mean: number | null;
  precipitation_sum: number | null;
  et0_fao_evapotranspiration: number | null;
  precipitation_probability_max: number | null;
  precipitation_hours: number | null;
  shortwave_radiation_sum: number | null;
  sunshine_duration: number | null;
  uv_index_max: number | null;
  wind_gusts_10m_max: number | null;
}

export interface WeatherBundle {
  lat: number;
  lon: number;
  timezone: string;
  current: {
    time: string;
    temperature_2m: number | null;
    relative_humidity_2m: number | null;
    apparent_temperature: number | null;
    precipitation: number | null;
    weather_code: number | null;
    wind_speed_10m: number | null;
    wind_gusts_10m: number | null;
    cloud_cover: number | null;
    surface_pressure: number | null;
    vapour_pressure_deficit: number | null;
  } | null;
  daily: DailyRow[]; // oldest -> newest (past first, then forecast)
  note: string;
}

// All of these are free and key-less on the Open-Meteo forecast endpoint. The
// agricultural additions (VPD, solar radiation, sunshine hours, precipitation
// hours, mean temperature, gusts) cost nothing extra — they ride the same call.
const CURRENT_FIELDS =
  "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,cloud_cover,surface_pressure,vapour_pressure_deficit";
const DAILY_FIELDS = [
  "temperature_2m_max",
  "temperature_2m_min",
  "temperature_2m_mean",
  "precipitation_sum",
  "et0_fao_evapotranspiration",
  "precipitation_probability_max",
  "precipitation_hours",
  "shortwave_radiation_sum",
  "sunshine_duration",
  "uv_index_max",
  "wind_gusts_10m_max",
].join(",");

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  temperature_2m_mean: (number | null)[];
  precipitation_sum: (number | null)[];
  et0_fao_evapotranspiration: (number | null)[];
  precipitation_probability_max: (number | null)[];
  precipitation_hours: (number | null)[];
  shortwave_radiation_sum: (number | null)[];
  sunshine_duration: (number | null)[];
  uv_index_max: (number | null)[];
  wind_gusts_10m_max: (number | null)[];
}

interface OpenMeteoCurrent {
  time: string;
  temperature_2m: number | null;
  relative_humidity_2m: number | null;
  apparent_temperature: number | null;
  precipitation: number | null;
  weather_code: number | null;
  wind_speed_10m: number | null;
  wind_gusts_10m: number | null;
  cloud_cover: number | null;
  surface_pressure: number | null;
  vapour_pressure_deficit: number | null;
}

export async function pingOpenMeteo(): Promise<string> {
  const d = await fetchJson<{ current: { time: string } | null }>(
    `${config.openMeteoBaseUrl}/forecast?latitude=0&longitude=0&current=temperature_2m&forecast_days=1&timezone=UTC`,
  );
  return d.current ? `ok at ${d.current.time}` : "ok";
}

/**
 * One call covering `pastDays` of history + `forecastDays` of forecast.
 * Past days are model reanalysis (ERA5-based blend), forecast days are model
 * prediction — neither is a physical sensor observation. Labels handled by the
 * evidence normalizer.
 */
export async function getWeatherBundle(
  lat: number,
  lon: number,
  opts: { pastDays?: number; forecastDays?: number } = {},
): Promise<WeatherBundle> {
  const pastDays = opts.pastDays ?? 30;
  const forecastDays = opts.forecastDays ?? 7;
  const url =
    `${config.openMeteoBaseUrl}/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=${CURRENT_FIELDS}` +
    `&daily=${DAILY_FIELDS}` +
    `&past_days=${pastDays}&forecast_days=${forecastDays}&timezone=auto`;
  const raw = await fetchJson<{
    latitude: number;
    longitude: number;
    timezone: string;
    current: OpenMeteoCurrent | null;
    daily: OpenMeteoDaily;
  }>(url);
  const daily = (raw.daily?.time ?? []).map((t, i) => ({
    date: t,
    temperature_2m_max: raw.daily?.temperature_2m_max?.[i] ?? null,
    temperature_2m_min: raw.daily?.temperature_2m_min?.[i] ?? null,
    temperature_2m_mean: raw.daily?.temperature_2m_mean?.[i] ?? null,
    precipitation_sum: raw.daily?.precipitation_sum?.[i] ?? null,
    et0_fao_evapotranspiration: raw.daily?.et0_fao_evapotranspiration?.[i] ?? null,
    precipitation_probability_max: raw.daily?.precipitation_probability_max?.[i] ?? null,
    precipitation_hours: raw.daily?.precipitation_hours?.[i] ?? null,
    shortwave_radiation_sum: raw.daily?.shortwave_radiation_sum?.[i] ?? null,
    sunshine_duration: raw.daily?.sunshine_duration?.[i] ?? null,
    uv_index_max: raw.daily?.uv_index_max?.[i] ?? null,
    wind_gusts_10m_max: raw.daily?.wind_gusts_10m_max?.[i] ?? null,
  }));
  return {
    lat: raw.latitude,
    lon: raw.longitude,
    timezone: raw.timezone ?? "auto",
    current: raw.current ?? null,
    daily,
    note: "Open-Meteo model output: current values are model nowcasts, past daily values are model reanalysis, future days are forecasts. Not physical sensor observations.",
  };
}

export interface SoilMoistureNow {
  time: string | null;
  layers: { depth: string; value: number | null }[];
  note: string;
}

/**
 * Modelled root-zone soil moisture (m³/m³) for the current hour, in three real
 * depth layers. Free and key-less on the same forecast endpoint.
 *
 * This is land-surface MODEL output, not a probe reading — it is stored as
 * PREDICTED and always second to a real soil-moisture sensor.
 */
export async function getSoilMoistureNow(lat: number, lon: number): Promise<SoilMoistureNow> {
  const url =
    `${config.openMeteoBaseUrl}/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=soil_moisture_0_to_1cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm` +
    `&past_days=1&forecast_days=1&timezone=auto`;
  const raw = await fetchJson<{
    utc_offset_seconds?: number;
    hourly?: {
      time: string[];
      soil_moisture_0_to_1cm: (number | null)[];
      soil_moisture_3_to_9cm: (number | null)[];
      soil_moisture_9_to_27cm: (number | null)[];
    };
  }>(url);
  const times = raw.hourly?.time ?? [];
  const note =
    "Open-Meteo land-surface model soil moisture. Model output for the requested depth layer — NOT a field probe measurement.";
  if (times.length === 0 || !raw.hourly) return { time: null, layers: [], note };
  // Match the current hour in the provider's own timezone, so the value is the
  // one that actually corresponds to now rather than midnight or tomorrow.
  const offsetMs = (raw.utc_offset_seconds ?? 0) * 1000;
  const nowLocalHour = new Date(Date.now() + offsetMs).toISOString().slice(0, 13);
  let idx = times.findIndex((t) => t.slice(0, 13) === nowLocalHour);
  if (idx < 0) idx = times.length - 1;
  return {
    time: times[idx] ?? null,
    layers: [
      { depth: "0-1cm", value: raw.hourly.soil_moisture_0_to_1cm?.[idx] ?? null },
      { depth: "3-9cm", value: raw.hourly.soil_moisture_3_to_9cm?.[idx] ?? null },
      { depth: "9-27cm", value: raw.hourly.soil_moisture_9_to_27cm?.[idx] ?? null },
    ],
    note,
  };
}

export interface AirQualityNow {
  time: string | null;
  pm2_5: number | null;
  pm10: number | null;
  dust: number | null;
  us_aqi: number | null;
  european_aqi: number | null;
  note: string;
}

/**
 * Air quality / particulate load for the current hour from the free CAMS-based
 * Open-Meteo air-quality endpoint. No key required.
 *
 * Relevant to farming beyond health: dust and particulate load affect spray
 * drift and residue-burning questions, and it is realtime-ish model output.
 */
export async function getAirQualityNow(lat: number, lon: number): Promise<AirQualityNow> {
  const url =
    `${config.openMeteoAirQualityBaseUrl}/air-quality?latitude=${lat}&longitude=${lon}` +
    `&current=pm2_5,pm10,dust,us_aqi,european_aqi&timezone=auto`;
  const raw = await fetchJson<{
    current?: {
      time: string;
      pm2_5: number | null;
      pm10: number | null;
      dust: number | null;
      us_aqi: number | null;
      european_aqi: number | null;
    };
  }>(url);
  return {
    time: raw.current?.time ?? null,
    pm2_5: raw.current?.pm2_5 ?? null,
    pm10: raw.current?.pm10 ?? null,
    dust: raw.current?.dust ?? null,
    us_aqi: raw.current?.us_aqi ?? null,
    european_aqi: raw.current?.european_aqi ?? null,
    note: "Open-Meteo air-quality (CAMS) model output for the current hour — atmospheric model values, not a local monitor.",
  };
}

export async function getElevation(lat: number, lon: number): Promise<{ elevation: number | null; lat: number; lon: number }> {
  const raw = await fetchJson<{ elevation?: number | number[] | null; latitude?: number; longitude?: number }>(
    `${config.openMeteoBaseUrl}/elevation?latitude=${lat}&longitude=${lon}`,
  );
  // the API returns an array when more than one point is queried and a number
  // for a single point; normalize both shapes
  const elevation = Array.isArray(raw.elevation) ? (raw.elevation[0] ?? null) : (raw.elevation ?? null);
  return { elevation: typeof elevation === "number" ? elevation : null, lat: raw.latitude ?? lat, lon: raw.longitude ?? lon };
}
