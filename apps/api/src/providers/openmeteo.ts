import { config } from "../config";
import { fetchJson } from "./orchestrator";

export interface DailyRow {
  date: string; // yyyy-mm-dd
  temperature_2m_max: number | null;
  temperature_2m_min: number | null;
  precipitation_sum: number | null;
  et0_fao_evapotranspiration: number | null;
  precipitation_probability_max: number | null;
}

export interface WeatherBundle {
  lat: number;
  lon: number;
  timezone: string;
  current: {
    time: string;
    temperature_2m: number | null;
    relative_humidity_2m: number | null;
    precipitation: number | null;
    weather_code: number | null;
    wind_speed_10m: number | null;
  } | null;
  daily: DailyRow[]; // oldest -> newest (past first, then forecast)
  note: string;
}

const CURRENT_FIELDS = "temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m";
const DAILY_FIELDS =
  "temperature_2m_max,temperature_2m_min,precipitation_sum,et0_fao_evapotranspiration,precipitation_probability_max";

interface OpenMeteoDaily {
  time: string[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
  et0_fao_evapotranspiration: (number | null)[];
  precipitation_probability_max: (number | null)[];
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
    current: { time: string; temperature_2m: number | null; relative_humidity_2m: number | null; precipitation: number | null; weather_code: number | null; wind_speed_10m: number | null } | null;
    daily: OpenMeteoDaily;
  }>(url);
  const daily = (raw.daily?.time ?? []).map((t, i) => ({
    date: t,
    temperature_2m_max: raw.daily?.temperature_2m_max?.[i] ?? null,
    temperature_2m_min: raw.daily?.temperature_2m_min?.[i] ?? null,
    precipitation_sum: raw.daily?.precipitation_sum?.[i] ?? null,
    et0_fao_evapotranspiration: raw.daily?.et0_fao_evapotranspiration?.[i] ?? null,
    precipitation_probability_max: raw.daily?.precipitation_probability_max?.[i] ?? null,
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

export async function getElevation(lat: number, lon: number): Promise<{ elevation: number | null; lat: number; lon: number }> {
  const raw = await fetchJson<{ elevation?: number | number[] | null; latitude?: number; longitude?: number }>(
    `${config.openMeteoBaseUrl}/elevation?latitude=${lat}&longitude=${lon}`,
  );
  // the API returns an array when more than one point is queried and a number
  // for a single point; normalize both shapes
  const elevation = Array.isArray(raw.elevation) ? (raw.elevation[0] ?? null) : (raw.elevation ?? null);
  return { elevation: typeof elevation === "number" ? elevation : null, lat: raw.latitude ?? lat, lon: raw.longitude ?? lon };
}
