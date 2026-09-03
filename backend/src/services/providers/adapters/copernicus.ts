import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { ProviderAdapter, ProviderResult } from '../registry';

export interface StacFeature {
  id: string;
  collection: string;
  datetime: string;
  geometry: GeoJSON.Geometry;
  properties: Record<string, any>;
  assets: Record<string, any>;
  bbox: number[];
}

export class CopernicusAdapter implements ProviderAdapter {
  id = 'copernicus';
  name = 'Copernicus Data Space Ecosystem';
  type: 'satellite' = 'satellite';
  status: 'AVAILABLE' | 'UNAVAILABLE' | 'PROVIDER_ERROR' = 'AVAILABLE';
  private stacUrl = 'https://stac.dataspace.copernicus.eu/v1';

  async healthCheck(): Promise<boolean> {
    try {
      const resp = await axios.get(`${this.stacUrl}/`, { timeout: 6000 });
      return resp.status === 200;
    } catch {
      this.status = 'UNAVAILABLE';
      return false;
    }
  }

  /**
   * STAC search over the official Copernicus Data Space catalog.
   * No credentials are required for catalog search; asset download may require
   * OAuth (reported truthfully as AUTH_REQUIRED at the download layer).
   */
  async searchProducts(input: {
    bbox: number[]; datetime: string; collections?: string[]; maxCloudCover?: number; limit?: number; sort?: string;
  }): Promise<ProviderResult<StacFeature[]>> {
    const start = Date.now();
    const requestId = uuidv4();
    const { bbox, datetime, collections = ['sentinel-2-l2a'], maxCloudCover = 100, limit = 20 } = input;
    try {
      const body: Record<string, unknown> = {
        collections,
        bbox,
        datetime,
        limit,
      };
      if (maxCloudCover < 100) {
        body['query'] = { 'eo:cloud_cover': { lte: maxCloudCover } };
      }
      const resp = await axios.post(`${this.stacUrl}/search`, body, { timeout: 20000 });
      const features: StacFeature[] = ((resp.data?.features || []) as any[]).map((f: any) => ({
        id: f.id,
        collection: f.collection,
        datetime: f.properties?.datetime || f.datetime,
        geometry: f.geometry,
        properties: f.properties || {},
        assets: f.assets || {},
        bbox: f.bbox || [],
      }));
      return {
        provider: this.id,
        requestId,
        status: features.length > 0 ? 'AVAILABLE' : 'NO_DATA',
        retrievedAt: new Date(),
        data: features,
        provenance: {
          provider: this.id,
          endpoint: `${this.stacUrl}/search`,
          params: { collections, bbox, datetime },
          catalog: 'Copernicus Data Space Ecosystem STAC',
        },
        quality: null,
        latency_ms: Date.now() - start,
        state: 'OBSERVED',
      };
    } catch (error: any) {
      const code = error?.code || '';
      const msg = error?.message || '';
      const status = code === 'ECONNABORTED' || /timeout/i.test(msg) ? 'TIMEOUT' : msg.includes('401') || msg.includes('403') ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR';
      return {
        provider: this.id, requestId, status, retrievedAt: new Date(), data: null,
        provenance: { provider: this.id, params: { collections, bbox, datetime } },
        quality: null, latency_ms: Date.now() - start, error: msg,
      };
    }
  }

  async getLatestForField(fieldGeometry: GeoJSON.Polygon, collections: string[] = ['sentinel-2-l2a'], maxCloudCover = 30): Promise<ProviderResult<StacFeature | null>> {
    const bbox = extractBbox(fieldGeometry, 0.005);
    const now = new Date();
    const rangeStart = new Date(now.getTime() - 45 * 86400000);
    const search = await this.searchProducts({
      bbox,
      datetime: `${rangeStart.toISOString()}/${now.toISOString()}`,
      collections,
      maxCloudCover,
      limit: 10,
      sort: 'properties.datetime:desc',
    });
    if (search.status !== 'AVAILABLE' || !search.data?.length) {
      return { ...search, data: null, status: search.status === 'AVAILABLE' ? 'NO_DATA' : search.status };
    }
    return { ...search, data: search.data[0] };
  }
}

/** BBox from canonical field geometry (shared util, buffer degrees). */
export function extractBbox(geometry: GeoJSON.Polygon, bufferDeg = 0.005): number[] {
  const ring = geometry?.coordinates?.[0] || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of ring) {
    minX = Math.min(minX, c[0]); minY = Math.min(minY, c[1]);
    maxX = Math.max(maxX, c[0]); maxY = Math.max(maxY, c[1]);
  }
  if (!Number.isFinite(minX)) return [77, 12, 78, 13];
  return [minX - bufferDeg, minY - bufferDeg, maxX + bufferDeg, maxY + bufferDeg];
}
