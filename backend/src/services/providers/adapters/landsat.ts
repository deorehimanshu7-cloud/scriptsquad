/**
 * Landsat Collection 2 adapter — Earth Search STAC (Element 84 / AWS Open Data).
 * Endpoint: https://earth-search.aws.element84.com/v1/search
 * Collection: landsat-c2-l2 (Collection 2 Level-2 SR/ST).
 * Public catalog, no credentials required.
 */
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { ProviderAdapter, ProviderResult } from '../registry';
import { extractBbox } from './copernicus';

export interface LandsatProduct {
  id: string;
  collection: string;
  datetime: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, any>;
  assets: Record<string, any>;
  bbox: number[];
}

export class LandsatAdapter implements ProviderAdapter {
  id = 'landsat-earth-search';
  name = 'Landsat Collection 2 (Earth Search)';
  type = 'satellite' as const;
  status: ProviderResult['status'] = 'AVAILABLE';
  private stacUrl = 'https://earth-search.aws.element84.com/v1';

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.stacUrl}/collections/landsat-c2-l2`, { timeout: 6000 });
      return resp.status === 200;
    } catch {
      this.status = 'UNAVAILABLE';
      return false;
    }
  }

  async searchProducts(input: { bbox: number[]; datetime: string; maxCloudCover?: number; limit?: number }): Promise<ProviderResult<LandsatProduct[]>> {
    const start = Date.now();
    const requestId = uuidv4();
    try {
      const resp = await axios.post(`${this.stacUrl}/search`, {
        collections: ['landsat-c2-l2'],
        bbox: input.bbox,
        datetime: input.datetime,
        limit: input.limit || 20,
        ...(input.maxCloudCover !== undefined ? { query: { 'eo:cloud_cover': { lte: input.maxCloudCover } } } : {}),
      }, { timeout: 20000 });
      const features: LandsatProduct[] = ((resp.data?.features || []) as any[]).map((f: any) => ({
        id: f.id, collection: f.collection, datetime: f.properties?.datetime || f.datetime,
        geometry: f.geometry, properties: f.properties || {}, assets: f.assets || {}, bbox: f.bbox || [],
      }));
      return {
        provider: this.id, requestId,
        status: features.length > 0 ? 'AVAILABLE' : 'NO_DATA',
        retrievedAt: new Date(), data: features,
        provenance: { provider: this.id, endpoint: `${this.stacUrl}/search`, catalog: 'Earth Search (AWS Open Data)', params: { collections: ['landsat-c2-l2'], bbox: input.bbox, datetime: input.datetime } },
        quality: null, latency_ms: Date.now() - start, state: 'OBSERVED',
      };
    } catch (error: any) {
      const msg = error?.message || '';
      const code = error?.code || '';
      return {
        provider: this.id, requestId,
        status: code === 'ECONNABORTED' || /timeout/i.test(msg) ? 'TIMEOUT' : msg.includes('401') || msg.includes('403') ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
        retrievedAt: new Date(), data: null, provenance: { provider: this.id }, quality: null,
        latency_ms: Date.now() - start, error: msg,
      };
    }
  }

  async getLatestForField(fieldGeometry: GeoJSON.Polygon, maxCloudCover = 30): Promise<ProviderResult<LandsatProduct | null>> {
    const bbox = extractBbox(fieldGeometry, 0.005);
    const now = new Date();
    const start = new Date(now.getTime() - 60 * 86400000);
    const r = await this.searchProducts({ bbox, datetime: `${start.toISOString()}/${now.toISOString()}`, maxCloudCover, limit: 10 });
    if (r.status !== 'AVAILABLE' || !r.data?.length) return { ...r, data: null, status: r.status === 'AVAILABLE' ? 'NO_DATA' : r.status };
    return { ...r, data: r.data[0] };
  }
}
