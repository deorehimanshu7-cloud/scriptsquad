/**
 * Provider Registry & typed result contract.
 *
 * Every external provider is reached exclusively through an adapter registered
 * here. Status vocabulary: AVAILABLE / NO_DATA / AUTH_REQUIRED / RATE_LIMITED /
 * TIMEOUT / PROVIDER_ERROR / UNAVAILABLE / DATA_QUALITY_FAILURE.
 * quality is null (NOT_ASSESSED) unless the adapter genuinely computed it.
 */
import type { QualityAssessment, ProviderStatus } from '@agrifur2/shared';

export type { ProviderStatus };

export interface ProviderResult<T = unknown> {
  provider: string;
  requestId: string;
  status: ProviderStatus;
  retrievedAt: Date;
  data: T | null;
  provenance: Record<string, any>;
  quality: QualityAssessment | null;
  latency_ms: number;
  error?: string;
  state?: string;
}

export interface ProviderCapabilities {
  search: boolean;
  retrieve: boolean;
  download: boolean;
  auth_required: boolean;
  data_types: string[];
  spatial: { aoi: boolean; point: boolean; bbox: boolean };
}

export interface ProviderAdapter {
  id: string;
  name: string;
  type: 'satellite' | 'weather' | 'water' | 'soil' | 'terrain' | 'sensor' | 'ai' | 'map';
  status: ProviderStatus;
  capabilities?: Partial<ProviderCapabilities>;
  healthCheck(): Promise<boolean>;
}

class ProviderRegistryClass {
  private providers = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.providers.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  getAll(): ProviderAdapter[] {
    return Array.from(this.providers.values());
  }

  getByType(type: string): ProviderAdapter[] {
    return this.getAll().filter((p) => p.type === type);
  }

  async healthCheckAll(): Promise<Record<string, ProviderStatus>> {
    const out: Record<string, ProviderStatus> = {};
    const results = await Promise.allSettled(this.getAll().map(async (p) => ({ id: p.id, ok: await p.healthCheck().catch(() => false) })));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const v = r.value;
        out[v.id] = v.ok ? 'AVAILABLE' : 'UNAVAILABLE';
      }
    }
    return out;
  }
}

export const ProviderRegistry = new ProviderRegistryClass();

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  type: string;
  requires_credentials: boolean;
  configured: boolean;
  auth_detail?: string;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  { id: 'copernicus', name: 'Copernicus Data Space Ecosystem (STAC)', type: 'satellite', requires_credentials: false, configured: true },
  { id: 'landsat-earth-search', name: 'Landsat Collection 2 (Earth Search STAC)', type: 'satellite', requires_credentials: false, configured: true },
  { id: 'bhoonidhi', name: 'Bhoonidhi / NRSC (ISRO Indian EO)', type: 'satellite', requires_credentials: true, configured: !!(process.env.BHOONIDHI_CLIENT_ID && process.env.BHOONIDHI_CLIENT_SECRET), auth_detail: 'Set BHOONIDHI_CLIENT_ID / BHOONIDHI_CLIENT_SECRET for authenticated catalog access.' },
  { id: 'open-meteo', name: 'Open-Meteo (forecast + ERA5 archive)', type: 'weather', requires_credentials: false, configured: true },
  { id: 'open-meteo-elevation', name: 'Open-Meteo elevation (DEM)', type: 'terrain', requires_credentials: false, configured: true },
  { id: 'soilgrids', name: 'SoilGrids v2 (ISRIC, modelled estimates)', type: 'soil', requires_credentials: false, configured: true },
  { id: 'ai-llm', name: 'LLM (OpenAI-compatible)', type: 'ai', requires_credentials: true, configured: !!process.env.AI_API_KEY, auth_detail: 'Set AI_API_KEY to enable LLM reasoning.' },
];
