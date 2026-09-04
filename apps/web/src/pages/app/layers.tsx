import { DomainWorkspace } from "./DomainWorkspace";

export function WeatherPage() {
  return (
    <DomainWorkspace
      domain="weather"
      title="Weather"
      icon="🌦️"
      blurb="Open-Meteo model output for this field's centroid: current nowcast, historical days and forecast days. Rows are PREDICTED/HISTORICAL model data — never physical sensor observations."
      providers={["openmeteo"]}
    />
  );
}

export function WaterPage() {
  return (
    <DomainWorkspace
      domain="water"
      title="Water"
      icon="🌊"
      blurb="Water layer. Surface-water context comes from the OpenStreetMap open spatial dataset (keyless — mapped water features near the field with distances; DERIVED, never presented as flow/depth). Groundwater/aquifer/irrigation intelligence needs the credential-gated India-WRIS/CGWB source and honestly reports NOT_CONFIGURED until configured."
      providers={["osm-water", "water-india"]}
    />
  );
}

export function SoilPage() {
  return (
    <DomainWorkspace
      domain="soil"
      title="Soil"
      icon="🟫"
      blurb="Soil properties by depth from legitimate sources. SoilGrids v2.0 values are global model ESTIMATES (never measurements); pH and EC are only shown when a real observation or a documented estimation model exists."
      providers={["soilgrids"]}
    />
  );
}

export function TerrainPage() {
  return (
    <DomainWorkspace
      domain="terrain"
      title="Terrain"
      icon="⛰️"
      blurb="Real DEM raster samples (NASA SRTM 90 m, ASTER GDEM 30 m fallback — keyless via OpenTopoData) over a grid inside the field polygon. Elevation min/max/mean and slope/aspect are DERIVED from the actual samples; if only a single centroid elevation is available it is labelled CENTROID ELEVATION and slope/aspect stay UNKNOWN. Never survey measurements."
      providers={["opentopodata", "openmeteo"]}
    />
  );
}

export function CropPage() {
  return (
    <DomainWorkspace
      domain="crop"
      title="Crop"
      icon="🌱"
      blurb="Crop layer: field metadata plus vegetation-relevant evidence. No validated growth-stage or yield model is connected; declared crops are farmer metadata, not independently verified."
      editableCrop
    />
  );
}