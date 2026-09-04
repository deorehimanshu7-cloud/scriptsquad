import { config } from "../config";
import { fetchJson } from "./orchestrator";

export interface SoilPropertyRow {
  property: string; // phh2o, cec, soc, clay, sand, silt, bdod, nitrogen
  depth: string; // e.g. 0-5cm
  mean: number | null;
  uncertainty: number | null;
  unit: string;
}

const PROPERTIES = ["phh2o", "cec", "soc", "clay", "sand", "silt", "bdod", "nitrogen"] as const;
export const SOIL_PROPERTY_UNITS: Record<string, string> = {
  phh2o: "pH x 10 (pH = value/10)",
  cec: "mmol(c)/kg",
  soc: "g/kg",
  clay: "g/kg",
  sand: "g/kg",
  silt: "g/kg",
  bdod: "cg/cm3",
  nitrogen: "g/kg",
};

export async function pingSoilGrids(): Promise<string> {
  // Primary probe: the v2.0 REST service. It has been paused by ISRIC (HTTP 000
  // / timeouts) — when it fails, fall back to the still-live keyless WCS map
  // server (maps.isric.org) so provider health truthfully reports AVAILABLE
  // while real 250 m model data is being served from the fallback path.
  try {
    const d = await fetchJson<{ type?: string }>(
      `${config.soilgridsBaseUrl}/properties/query?lon=75&lat=20&property=phh2o&depth=0-5cm&value=mean`,
      undefined,
      5_000,
    );
    return d.type ? "ok" : "ok";
  } catch {
    const { pingSoilGridsWcs } = await import("./soilgridsWcs");
    return await pingSoilGridsWcs();
  }
}

/**
 * SoilGrids v2.0 global model estimates. These are MODEL ESTIMATES, never
 * field measurements — mapped to state ESTIMATED with model provenance.
 * SoilGrids does not provide electrical conductivity (EC); EC stays UNKNOWN
 * unless a real lab/sensor observation exists.
 */
export async function getSoilProperties(lon: number, lat: number): Promise<SoilPropertyRow[]> {
  const params = new URLSearchParams();
  params.set("lon", String(lon));
  params.set("lat", String(lat));
  for (const p of PROPERTIES) params.append("property", p);
  for (const d of ["0-5cm", "5-15cm", "15-30cm", "30-60cm"]) params.append("depth", d);
  params.set("value", "mean");
  const url = `${config.soilgridsBaseUrl}/properties/query?${params.toString()}`;
  const res = await fetchJson<{
    properties?: {
      layers?: { name: string; depths?: { name: string; values?: { mean: number | null; uncertainty: number | null } }[] }[];
    };
  }>(url, undefined, 20_000);

  const rows: SoilPropertyRow[] = [];
  for (const layer of res.properties?.layers ?? []) {
    for (const depth of layer.depths ?? []) {
      rows.push({
        property: layer.name,
        depth: depth.name,
        mean: depth.values?.mean ?? null,
        uncertainty: depth.values?.uncertainty ?? null,
        unit: SOIL_PROPERTY_UNITS[layer.name] ?? "",
      });
    }
  }
  return rows;
}
