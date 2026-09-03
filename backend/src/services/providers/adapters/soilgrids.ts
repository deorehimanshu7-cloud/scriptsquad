/**
 * SoilGrids v2.0 adapter (ISRIC — https://rest.isric.org/soilgrids/v2.0).
 *
 * SoilGrids returns MACHINE-LEARNING MODELLED ESTIMATES with quantified
 * uncertainty (prediction intervals). Every value returned here is therefore
 * labelled ESTIMATED / MODEL_DERIVED with the provider's own uncertainty —
 * never OBSERVED. pH/EC from SoilGrids are estimates, which is acceptable ONLY
 * with that explicit label.
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { ProviderAdapter, ProviderResult } from '../registry';

export interface SoilgridsPropertyResult {
  property: string;
  depth: string;
  value_mean: number | null;
  unit: string;
  uncertainty_mean: number | null;
  uncertainty_unit: string;
  provenance_units?: Record<string, unknown>;
}

// property codes supported by SoilGrids v2 query API
export const SOILGRIDS_PROPERTIES = ['phh2o', 'ecx', 'ocd', 'soc', 'nitrogen', 'sand', 'silt', 'clay', 'bdod', 'cec'];

export class SoilGridsAdapter implements ProviderAdapter {
  id = 'soilgrids';
  name = 'SoilGrids v2 (ISRIC)';
  type = 'soil' as const;
  status: ProviderResult['status'] = 'AVAILABLE';
  private base = 'https://rest.isric.org/soilgrids/v2.0';
  // map SoilGrids codes → domain property + display unit
  private readonly mapping: Record<string, { property: string; unit: string; label: string }> = {
    phh2o: { property: 'ph', unit: 'pH', label: 'soil pH (water)' },
    ecx: { property: 'ec', unit: 'dS/m', label: 'electrical conductivity (saturated paste)' },
    ocd: { property: 'organic_carbon_density', unit: 'kg/m³', label: 'organic carbon density' },
    soc: { property: 'organic_carbon', unit: 'g/kg', label: 'organic carbon content' },
    nitrogen: { property: 'nitrogen', unit: 'g/kg', label: 'total nitrogen' },
    sand: { property: 'sand', unit: 'g/kg', label: 'sand content' },
    silt: { property: 'silt', unit: 'g/kg', label: 'silt content' },
    clay: { property: 'clay', unit: 'g/kg', label: 'clay content' },
    bdod: { property: 'bulk_density', unit: 'kg/m³', label: 'bulk density' },
    cec: { property: 'cec', unit: 'cmol(c)/kg', label: 'cation exchange capacity' },
  };

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.base}/properties/query`, {
        params: { lon: 77.59, lat: 12.97, property: 'phh2o', depth: '0-5cm' },
        timeout: 8000,
      });
      return resp.status === 200;
    } catch {
      this.status = 'UNAVAILABLE';
      return false;
    }
  }

  async queryPoint(lon: number, lat: number, properties?: string[], depths: string[] = ['0-5cm', '5-15cm', '15-30cm']): Promise<ProviderResult<SoilgridsPropertyResult[]>> {
    const start = Date.now();
    const requestId = uuidv4();
    const props = properties && properties.length > 0 ? properties : SOILGRIDS_PROPERTIES;
    // rest.isric.org currently answers 500 to any multi-property query, so each
    // property is requested individually (small bounded concurrency).
    const self = this;
    const failures: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const fetchOne = async (prop: string): Promise<SoilgridsPropertyResult[]> => {
      // one property per request (multi-property queries 500), depth as array
      let lastError: any = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const resp = await axios.get(`${self.base}/properties/query`, {
            params: { lon, lat, property: prop, depth: depths },
            timeout: 45000,
          });
          const out: SoilgridsPropertyResult[] = [];
          // SoilGrids v2 returns { properties: { layers: [...] } }
          const propsData = resp.data?.properties;
          const layers = Array.isArray(propsData) ? propsData : (propsData?.layers || []);
          for (const layer of layers) {
            const mapping = self.mapping[layer.name];
            // SoilGrids raw integers need d_factor scaling into target units
            const um = layer.unit_measure || {};
            const factor = um.d_factor && um.d_factor > 0 ? um.d_factor : 1;
            const target = um.target_units === '-' ? 'pH' : (um.target_units || mapping?.unit || '');
            const scale = (v: number | null): number | null =>
              v === null || v === undefined ? null : Math.round((v / factor) * 1000) / 1000;
            for (const d of layer.depths || []) {
              const label = d.label || (d.range ? `${d.range.top_depth}-${d.range.bottom_depth}cm` : undefined);
              const valueMean = d.values?.mean ?? null;
              const uncMean = d.values?.uncertainty?.mean ?? null;
              if (valueMean === null || !label) continue;
              out.push({
                property: mapping?.property || layer.name,
                depth: label,
                value_mean: scale(valueMean),
                unit: target,
                uncertainty_mean: scale(uncMean),
                uncertainty_unit: target,
                provenance_units: { raw: valueMean, d_factor: um.d_factor, mapped_units: um.mapped_units, target_units: um.target_units },
              });
            }
          }
          if (out.length === 0) throw new Error(`No ${prop} values returned for depth(s) ${depths.join(',')}`);
          return out;
        } catch (e: any) {
          lastError = e;
          if (attempt === 1) await sleep(1500);
        }
      }
      failures.push(`${prop} (${lastError?.message || 'request failed'})`);
      return [];
    };
    try {
      const results: SoilgridsPropertyResult[] = [];
      const concurrency = 3;
      let idx = 0;
      const worker = async () => {
        while (idx < props.length) {
          const prop = props[idx++];
          const rows = await fetchOne(prop);
          results.push(...rows);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, props.length) }, () => worker()));
      const status = results.length > 0 ? 'AVAILABLE' : 'PROVIDER_ERROR';
      return {
        provider: this.id, requestId,
        status,
        retrievedAt: new Date(), data: results,
        provenance: {
          provider: this.id,
          endpoint: `${this.base}/properties/query`,
          params: { lon, lat, properties: props, depths },
          dataset: 'SoilGrids v2.0 (250m, ML-modelled)',
          partial_failures: failures,
        },
        quality: { completeness: results.length > 0 ? 1 : 0, validity: null, freshness: null, spatial_compatibility: null, temporal_compatibility: null, source_reliability: null, calibration: null, range_plausibility: null, cross_source_agreement: null },
        latency_ms: Date.now() - start,
        state: 'ESTIMATED',
        error: failures.length > 0 ? `Partial SoilGrids failure for: ${failures.join('; ')}` : undefined,
      };
    } catch (error: any) {
      const msg = error?.message || '';
      return {
        provider: this.id, requestId,
        status: msg.includes('429') ? 'RATE_LIMITED' : msg.includes('504') || msg.includes('500') ? 'PROVIDER_ERROR' : msg.includes('401') ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
        retrievedAt: new Date(), data: null, provenance: { provider: this.id, params: { lon, lat } },
        quality: null, latency_ms: Date.now() - start, error: msg,
      };
    }
  }
}
