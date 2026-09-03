import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { ProviderAdapter, ProviderResult } from '../registry';
import type { WeatherDataset, WeatherDaily } from '@agrifur2/shared';

export type WeatherKind = 'forecast' | 'history';

export class OpenMeteoAdapter implements ProviderAdapter {
  id = 'open-meteo';
  name = 'Open-Meteo';
  type: 'weather' = 'weather';
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'PROVIDER_ERROR' = 'AVAILABLE';
  private forecastUrl = 'https://api.open-meteo.com/v1/forecast';
  private archiveUrl = 'https://archive-api.open-meteo.com/v1/archive';

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await axios.get(this.forecastUrl, {
        params: { latitude: 12.97, longitude: 77.59, current_weather: true },
        timeout: 6000,
      });
      return resp.status === 200;
    } catch {
      this.status = 'UNAVAILABLE';
      return false;
    }
  }

  /**
   * Current conditions + 7-day forecast. Model output → state MODEL_DERIVED /
   * PREDICTED (never "observed"). Quality: completeness reflects the fraction
   * of requested variables actually returned; everything else NOT_ASSESSED.
   */
  async fetchWeather(lat: number, lng: number): Promise<ProviderResult<WeatherDataset>> {
    const start = Date.now();
    const requestId = uuidv4();
    try {
      const resp = await axios.get(this.forecastUrl, {
        params: {
          latitude: lat,
          longitude: lng,
          current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation,surface_pressure',
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max',
          hourly: 'temperature_2m,relative_humidity_2m,precipitation',
          forecast_days: 7,
          timezone: 'auto',
        },
        timeout: 12000,
      });
      const d = resp.data;
      const current = d.current
        ? {
            temperature_c: d.current.temperature_2m,
            humidity_pct: d.current.relative_humidity_2m,
            wind_speed_kmh: d.current.wind_speed_10m,
            precipitation_mm: d.current.precipitation ?? 0,
            pressure_hpa: d.current.surface_pressure ?? null,
            observed_at: new Date(d.current.time).toISOString(),
          }
        : null;
      const daily: WeatherDaily[] = (d.daily?.time || []).map((date: string, i: number) => ({
        date,
        temp_max_c: d.daily.temperature_2m_max[i],
        temp_min_c: d.daily.temperature_2m_min[i],
        precipitation_sum_mm: d.daily.precipitation_sum[i],
        wind_speed_max_kmh: d.daily.wind_speed_10m_max?.[i] ?? null,
      }));
      const hourly = (d.hourly?.time || []).slice(0, 72).map((time: string, i: number) => ({
        time,
        temperature_c: d.hourly.temperature_2m[i],
        humidity_pct: d.hourly.relative_humidity_2m[i],
        precipitation_mm: d.hourly.precipitation[i],
      }));
      return {
        provider: this.id,
        requestId,
        status: current ? 'AVAILABLE' : 'NO_DATA',
        retrievedAt: new Date(),
        data: {
          provider: this.id,
          dataset: 'open-meteo-forecast (ECMWF-based model output)',
          semantics: 'MODEL_DERIVED',
          current,
          daily,
          hourly,
          coordinates: { lat, lng },
          retrieved_at: new Date().toISOString(),
        },
        provenance: { provider: this.id, endpoint: this.forecastUrl, params: { lat, lng }, dataset: 'open-meteo-forecast' },
        quality: { completeness: d.current ? 1 : 0, validity: null, freshness: null, spatial_compatibility: null, temporal_compatibility: null, source_reliability: null, calibration: null, range_plausibility: null, cross_source_agreement: null },
        latency_ms: Date.now() - start,
        state: 'MODEL_DERIVED',
      };
    } catch (error: any) {
      return this.err(requestId, start, error, { lat, lng });
    }
  }

  /**
   * Historical weather (ERA5 / ERA5-Land reanalysis through Open-Meteo Archive).
   * Semantics are REANALYSIS — never presented as physical observation.
   */
  async fetchHistory(lat: number, lng: number, days = 30): Promise<ProviderResult<WeatherDataset>> {
    const start = Date.now();
    const requestId = uuidv4();
    const end = new Date();
    const startDate = new Date(end.getTime() - days * 86400000);
    const fmt = (dt: Date) => dt.toISOString().slice(0, 10);
    try {
      const resp = await axios.get(this.archiveUrl, {
        params: {
          latitude: lat, longitude: lng,
          start_date: fmt(startDate), end_date: fmt(end),
          daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum',
          timezone: 'auto',
        },
        timeout: 15000,
      });
      const d = resp.data;
      const daily: WeatherDaily[] = (d.daily?.time || []).map((date: string, i: number) => ({
        date,
        temp_max_c: d.daily.temperature_2m_max[i],
        temp_min_c: d.daily.temperature_2m_min[i],
        precipitation_sum_mm: d.daily.precipitation_sum[i],
      }));
      return {
        provider: this.id, requestId,
        status: daily.length > 0 ? 'AVAILABLE' : 'NO_DATA',
        retrievedAt: new Date(),
        data: {
          provider: this.id,
          dataset: 'ERA5 reanalysis via Open-Meteo Archive',
          semantics: 'REANALYSIS',
          current: null,
          daily,
          hourly: [],
          coordinates: { lat, lng },
          retrieved_at: new Date().toISOString(),
        },
        provenance: { provider: this.id, endpoint: this.archiveUrl, params: { lat, lng, days }, dataset: 'ERA5' },
        quality: { completeness: daily.length > 0 ? 1 : 0, validity: null, freshness: null, spatial_compatibility: null, temporal_compatibility: null, source_reliability: null, calibration: null, range_plausibility: null, cross_source_agreement: null },
        latency_ms: Date.now() - start,
        state: 'REANALYSIS',
      };
    } catch (error: any) {
      return this.err(requestId, start, error, { lat, lng, kind: 'history' });
    }
  }

  /** Elevation from Open-Meteo terrain elevation API (DEM sample, derived). */
  async fetchElevation(lat: number, lng: number): Promise<ProviderResult<{ elevation_m: number | null }>> {
    const start = Date.now();
    const requestId = uuidv4();
    try {
      const resp = await axios.get('https://api.open-meteo.com/v1/elevation', {
        params: { latitude: lat, longitude: lng },
        timeout: 10000,
      });
      const raw = resp.data?.elevation;
      // the elevation endpoint answers [518.0] (array form)
      const elevation = Array.isArray(raw) ? raw[0] : raw;
      const ok = typeof elevation === 'number' && Number.isFinite(elevation);
      return {
        provider: 'open-meteo-elevation', requestId,
        status: ok ? 'AVAILABLE' : 'NO_DATA',
        retrievedAt: new Date(),
        data: { elevation_m: ok ? elevation : null },
        provenance: { provider: 'open-meteo-elevation', endpoint: 'https://api.open-meteo.com/v1/elevation', params: { lat, lng }, dataset: 'open-meteo-dem' },
        quality: null,
        latency_ms: Date.now() - start,
        state: 'DERIVED',
      };
    } catch (error: any) {
      return { provider: 'open-meteo-elevation', requestId, status: 'PROVIDER_ERROR', retrievedAt: new Date(), data: null, provenance: {}, quality: null, latency_ms: Date.now() - start, error: error.message };
    }
  }

  private err(requestId: string, start: number, error: any, params: Record<string, unknown>): ProviderResult<WeatherDataset> {
    const timeout = error?.code === 'ECONNABORTED' || /timeout/i.test(error?.message || '');
    return {
      provider: this.id, requestId,
      status: timeout ? 'TIMEOUT' : 'PROVIDER_ERROR',
      retrievedAt: new Date(), data: null,
      provenance: { provider: this.id, params },
      quality: null, latency_ms: Date.now() - start, error: error?.message,
    };
  }
}
