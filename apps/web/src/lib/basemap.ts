/**
 * Shared basemap / satellite imagery sources for every map in the app.
 *
 * Why this module exists: the satellite style used to be an inline object
 * copy-pasted into two pages, with a single raster source and NO zoom ceiling.
 * MapLibre's default maxZoom is 22, but the imagery service's native detail runs
 * out around z19 — past that point the map kept requesting tiles the service
 * could only upscale, so zooming in produced progressively blurrier mush with no
 * indication that you had left the real resolution behind.
 *
 * Everything here is free and key-less (Esri public services + EOX Sentinel-2
 * cloudless). Sources declare their REAL native max zoom so the app can say
 * honestly when it is upscaling, and clarity is exposed as raster paint
 * properties (contrast/saturation) plus a zero fade duration, which is what
 * actually removes the blur during zoom and pan.
 */
import type { StyleSpecification } from "maplibre-gl";

const ESRI_IMAGERY = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const S2_CLOUDLESS = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";
const ESRI_HILLSHADE = "https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}";
const ESRI_LABELS = "https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";

export const CARTO_DARK = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
export const CARTO_LIGHT = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export type ImageryId = "auto" | "esri" | "s2" | "dark" | "light";
export type ClarityId = "natural" | "enhanced" | "high-contrast";

export interface ImageryOption {
  id: ImageryId;
  labelKey: string;
  /** Native max zoom of the underlying service — beyond this tiles are upscaled. */
  nativeMaxZoom: number | null;
  /** Approximate ground resolution of the source imagery, metres per pixel. */
  nativeMetresPerPixel: number | null;
  attribution: string | null;
  noteKey: string;
}

export const IMAGERY_OPTIONS: ImageryOption[] = [
  {
    id: "auto",
    labelKey: "map.auto",
    nativeMaxZoom: 19,
    nativeMetresPerPixel: 0.3,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics · Sentinel-2 cloudless © EOX",
    noteKey: "map.noteAuto",
  },
  {
    id: "esri",
    labelKey: "map.esri",
    nativeMaxZoom: 19,
    nativeMetresPerPixel: 0.3,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    noteKey: "map.noteEsri",
  },
  {
    id: "s2",
    labelKey: "map.s2",
    nativeMaxZoom: 16,
    nativeMetresPerPixel: 10,
    attribution: "Sentinel-2 cloudless © EOX (contains modified Copernicus data)",
    noteKey: "map.noteS2",
  },
  {
    id: "dark",
    labelKey: "map.dark",
    nativeMaxZoom: null,
    nativeMetresPerPixel: null,
    attribution: "© OpenStreetMap contributors © CARTO",
    noteKey: "map.noteDark",
  },
  {
    id: "light",
    labelKey: "map.light",
    nativeMaxZoom: null,
    nativeMetresPerPixel: null,
    attribution: "© OpenStreetMap contributors © CARTO",
    noteKey: "map.noteLight",
  },
];

/** Zoom at which the auto mode hands over from regional to high-detail imagery. */
export const AUTO_HANDOVER_ZOOM = 12;

interface ClarityPreset {
  contrast: number;
  saturation: number;
  brightnessMax: number;
}

const CLARITY: Record<ClarityId, ClarityPreset> = {
  natural: { contrast: 0, saturation: 0, brightnessMax: 1 },
  enhanced: { contrast: 0.12, saturation: 0.2, brightnessMax: 1 },
  "high-contrast": { contrast: 0.28, saturation: 0.32, brightnessMax: 0.98 },
};

export const CLARITY_OPTIONS: { id: ClarityId; labelKey: string }[] = [
  { id: "natural", labelKey: "map.natural" },
  { id: "enhanced", labelKey: "map.enhanced" },
  { id: "high-contrast", labelKey: "map.highContrast" },
];

export interface BasemapOptions {
  imagery: ImageryId;
  clarity?: ClarityId;
  /** Overlay Esri place names / boundaries. */
  labels?: boolean;
  /** Overlay terrain hillshade — useful for reading slope on a farm. */
  hillshade?: boolean;
}

/** Raster paint that keeps imagery crisp; fade-duration 0 removes the blurry crossfade. */
function rasterPaint(clarity: ClarityId, opacity = 1): Record<string, number> {
  const c = CLARITY[clarity];
  return {
    "raster-fade-duration": 0,
    "raster-opacity": opacity,
    "raster-contrast": c.contrast,
    "raster-saturation": c.saturation,
    "raster-brightness-max": c.brightnessMax,
  };
}

/**
 * Build a MapLibre style for the chosen imagery.
 * Returns a URL string for the vector basemaps, or a full style spec for raster.
 */
export function buildBasemapStyle(opts: BasemapOptions): StyleSpecification | string {
  const { imagery, clarity = "enhanced", labels = false, hillshade = false } = opts;
  if (imagery === "dark") return CARTO_DARK;
  if (imagery === "light") return CARTO_LIGHT;

  const sources: StyleSpecification["sources"] = {};
  const layers: StyleSpecification["layers"] = [];

  if (imagery === "auto") {
    // Two raster layers with disjoint zoom ranges: true-colour 10 m regional
    // imagery when zoomed out, high-resolution aerial when zoomed in. One style,
    // no blurry overzoom of a single source across the whole range.
    sources["imagery-regional"] = {
      type: "raster",
      tiles: [S2_CLOUDLESS],
      tileSize: 256,
      minzoom: 0,
      maxzoom: AUTO_HANDOVER_ZOOM,
      attribution: IMAGERY_OPTIONS[0].attribution ?? "",
    };
    sources["imagery-detail"] = {
      type: "raster",
      tiles: [ESRI_IMAGERY],
      tileSize: 256,
      minzoom: AUTO_HANDOVER_ZOOM,
      maxzoom: 19,
      attribution: IMAGERY_OPTIONS[0].attribution ?? "",
    };
    layers.push({
      id: "imagery-regional",
      type: "raster",
      source: "imagery-regional",
      maxzoom: AUTO_HANDOVER_ZOOM,
      paint: rasterPaint(clarity),
    });
    layers.push({
      id: "imagery-detail",
      type: "raster",
      source: "imagery-detail",
      minzoom: AUTO_HANDOVER_ZOOM,
      paint: rasterPaint(clarity),
    });
  } else {
    const def = imagery === "esri" ? IMAGERY_OPTIONS[1] : IMAGERY_OPTIONS[2];
    sources["imagery"] = {
      type: "raster",
      tiles: [imagery === "esri" ? ESRI_IMAGERY : S2_CLOUDLESS],
      tileSize: 256,
      minzoom: 0,
      maxzoom: def.nativeMaxZoom ?? 19,
      attribution: def.attribution ?? "",
    };
    layers.push({ id: "imagery", type: "raster", source: "imagery", paint: rasterPaint(clarity) });
  }

  if (hillshade) {
    // Low opacity on purpose: it must read as relief shading, not replace the imagery.
    sources["hillshade"] = {
      type: "raster",
      tiles: [ESRI_HILLSHADE],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 15,
      attribution: "Hillshade © Esri",
    };
    layers.push({ id: "hillshade", type: "raster", source: "hillshade", paint: { "raster-fade-duration": 0, "raster-opacity": 0.28 } });
  }

  if (labels) {
    sources["place-labels"] = {
      type: "raster",
      tiles: [ESRI_LABELS],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 13,
      attribution: "Place names © Esri",
    };
    layers.push({ id: "place-labels", type: "raster", source: "place-labels", paint: { "raster-fade-duration": 0, "raster-opacity": 0.85 } });
  }

  return { version: 8, sources, layers };
}

/** Ground resolution at a given latitude and zoom (Web Mercator). */
export function groundMetresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

export interface DetailStatus {
  metresPerPixel: number;
  nativeMetresPerPixel: number | null;
  /** True when the view is finer than the imagery can actually resolve. */
  beyondNative: boolean;
  sourceMaxZoom: number | null;
}

/**
 * Describe how much real detail the current view can possibly contain, so the UI
 * can say "you are past the imagery's resolution" instead of silently showing
 * upscaled pixels as if they were detail.
 */
export function detailStatus(imagery: ImageryId, lat: number, zoom: number): DetailStatus {
  const def = IMAGERY_OPTIONS.find((o) => o.id === imagery) ?? IMAGERY_OPTIONS[0];
  const metresPerPixel = groundMetresPerPixel(lat, zoom);
  const native = def.nativeMetresPerPixel;
  return {
    metresPerPixel,
    nativeMetresPerPixel: native,
    beyondNative: native !== null && metresPerPixel < native * 0.75,
    sourceMaxZoom: def.nativeMaxZoom,
  };
}
