import type { ProviderId, ProviderState } from "contracts";
import { config } from "../config";

export interface ProviderResult<T = unknown> {
  provider: ProviderId;
  requestId: string;
  status: ProviderState;
  retrievedAt: string;
  latencyMs: number | null;
  data: T | null;
  error: string | null;
  note?: string;
}

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  category: string;
  auth: "none" | "optional" | "required";
  auth_state: "none" | "configured" | "required" | "unknown";
  keylessCapabilities: string[];
  credentialCapabilities?: string[];
  docsUrl?: string;
}

function buildMetas(): Record<ProviderId, ProviderMeta> {
  return {
    sensors: {
      id: "sensors",
      name: "Local sensor ingestion",
      category: "hardware",
      auth: "none",
      auth_state: "none",
      keylessCapabilities: ["device registration", "telemetry ingestion (HTTPS)", "heartbeat", "dedupe"],
    },
    "mqtt-broker": {
      id: "mqtt-broker",
      name: "MQTT broker (Mosquitto, LAN)",
      category: "hardware",
      auth: "optional",
      auth_state: config.mqtt.brokerUrl && config.mqtt.enabled ? (config.mqtt.username ? "configured" : "none") : "unknown",
      keylessCapabilities: ["LAN telemetry ingest (port 1883)", "device heartbeat", "automatic reconnect"],
      credentialCapabilities: ["username/password auth", "TLS (production)"],
      docsUrl: "https://mosquitto.org/man/mosquitto-conf-5.html",
    },
    openmeteo: {
      id: "openmeteo",
      name: "Open-Meteo",
      category: "weather",
      auth: "none",
      auth_state: "none",
      keylessCapabilities: ["forecast", "historical (ERA5 model reanalysis)", "elevation (DEM)"],
      docsUrl: "https://open-meteo.com/en/docs",
    },
    opentopodata: {
      id: "opentopodata",
      name: "OpenTopoData (NASA SRTM / ASTER GDEM)",
      category: "terrain",
      auth: "none",
      auth_state: "none",
      keylessCapabilities: ["real DEM samples (SRTM 90 m)", "ASTER GDEM 30 m fallback", "elevation range / slope / aspect from DEM"],
      docsUrl: "https://www.opentopodata.org",
    },
    copernicus: {
      id: "copernicus",
      name: "Copernicus Data Space (Sentinel / Landsat)",
      category: "satellite",
      auth: "optional",
      auth_state: config.copernicusClientId ? "configured" : "required",
      keylessCapabilities: ["STAC product discovery", "metadata / acquisitions", "cloud cover filter"],
      credentialCapabilities: ["raster/asset download", "previews"],
      docsUrl: "https://documentation.dataspace.copernicus.eu/",
    },
    soilgrids: {
      id: "soilgrids",
      name: "SoilGrids (ISRIC)",
      category: "soil",
      auth: "none",
      auth_state: "none",
      keylessCapabilities: ["soil property estimates (model-derived)", "depth profiles"],
      docsUrl: "https://rest.isric.org",
    },
    "water-india": {
      id: "water-india",
      name: "India water datasets (India-WRIS / CGWB)",
      category: "water",
      auth: "required",
      auth_state: "unknown",
      keylessCapabilities: [],
      credentialCapabilities: ["surface water", "groundwater context", "irrigation"],
    },
    "osm-water": {
      id: "osm-water",
      name: "OpenStreetMap water features (open spatial dataset)",
      category: "water",
      auth: "none",
      auth_state: "none",
      keylessCapabilities: ["mapped waterways/rivers/canals", "water bodies near field", "distance to nearest water feature"],
      docsUrl: "https://wiki.openstreetmap.org/wiki/Overpass_API",
    },
    bhoonidhi: {
      id: "bhoonidhi",
      name: "Bhoonidhi / NRSC / ISRO",
      category: "satellite",
      auth: "required",
      auth_state: config.bhoonidhi.clientId ? "configured" : "required",
      keylessCapabilities: [],
      credentialCapabilities: ["NRSC product search"],
    },
    llm: {
      id: "llm",
      name: "Language model provider",
      category: "ai",
      auth: "optional",
      auth_state: config.llm.apiKey ? "configured" : "required",
      keylessCapabilities: [],
      credentialCapabilities: ["grounded Q&A"],
    },
  };
}

export const PROVIDER_METAS: Record<ProviderId, ProviderMeta> = buildMetas();
