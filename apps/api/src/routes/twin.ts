import { Router } from "express";
import type { Request } from "express";
import type { AppDb } from "../db";
import { getOwnedField, requireAuth } from "../http";
import { getFieldRow } from "../services/worldModel";
import { round } from "../util";

/**
 * Digital Twin composer. The twin is a spatial representation of the Farm
 * World Model: every layer comes from real recorded state and declares its
 * truth state. Layers with no data are NO_DATA/NOT_CONFIGURED/UNKNOWN — the
 * 3D scene renders those states honestly, never fabricating terrain, soil,
 * crops, sensors or water.
 */
export function twinRoutes(db: AppDb): Router {
  const r = Router();
  r.use(requireAuth(db));
  const fld = (req: Request) => getOwnedField(db, String(req.params.id), req.user!);

  r.get("/fields/:id/digital-twin", (req, res, next) => {
    try {
      const f = fld(req);
      const field = getFieldRow(db, f.id);
      if (!field) {
        res.status(404).json({ error: { code: "FIELD_NOT_FOUND", message: "Field not found" } });
        return;
      }

      // --- terrain (real DEM grid samples when available, else honest single-point)
      const terrainRows = db.conn
        .query("SELECT id, sub_type, value, unit, state, source, geometry, retrieved_at FROM evidence WHERE field_id=? AND domain='terrain' ORDER BY retrieved_at DESC LIMIT 120")
        .all(field.id) as {
        id: string;
        sub_type: string;
        value: number | null;
        unit: string | null;
        state: string;
        source: string;
        geometry: string | null;
        retrieved_at: string;
      }[];
      const terrainBySub = new Map(terrainRows.map((r) => [r.sub_type, r]));
      const demSamples = terrainRows
        .filter((r) => r.sub_type === "elevation_sample_m" && r.value !== null && r.geometry)
        .map((r) => {
          let lat = field.centroid_lat;
          let lon = field.centroid_lon;
          try {
            const g = JSON.parse(r.geometry as string) as { type: string; coordinates: number[] };
            if (g.type === "Point" && g.coordinates.length >= 2) {
              lon = g.coordinates[0];
              lat = g.coordinates[1];
            }
          } catch {
            /* keep centroid */
          }
          return { lat, lon, elevation_m: r.value as number };
        });
      const terrainLatest = terrainRows[0];
      const terrain = {
        state: terrainRows.length > 0 ? "PARTIAL" : "NO_DATA",
        dataset: terrainBySub.get("dem_sample_count") ? (terrainBySub.get("elevation_mean_m")?.source ?? "DEM") : "centroid-point",
        elevation_m: (terrainBySub.get("elevation_mean_m")?.value ?? terrainBySub.get("elevation_m")?.value) ?? null,
        elevation_min_m: terrainBySub.get("elevation_min_m")?.value ?? null,
        elevation_max_m: terrainBySub.get("elevation_max_m")?.value ?? null,
        slope_degrees: terrainBySub.get("slope_degrees")?.value ?? null,
        aspect_degrees: terrainBySub.get("aspect_degrees")?.value ?? null,
        sample_count: terrainBySub.get("dem_sample_count")?.value ?? demSamples.length,
        samples: demSamples,
        unit: terrainBySub.get("elevation_mean_m")?.unit ?? "m",
        source: terrainLatest?.source ?? null,
        evidence_id: terrainLatest?.id ?? null,
        retrieved_at: terrainLatest?.retrieved_at ?? null,
        note:
          demSamples.length >= 4
            ? `Real DEM grid: ${demSamples.length} SRTM/ASTER raster samples inside the field (DERIVED). The twin surface is displaced from these actual elevations; slope/aspect (when present) are derivations from the real samples, not measurements.`
            : terrainLatest
              ? "CENTROID ELEVATION only (single point). No DEM grid — the twin renders a flat surface and slope/aspect stay UNKNOWN."
              : "No terrain evidence recorded.",
      };

      // --- soil (estimates only, never measurements)
      const soilRows = db.conn
        .query("SELECT sub_type, value, unit, state, source, provenance FROM evidence WHERE field_id=? AND domain='soil' ORDER BY observed_at DESC LIMIT 12")
        .all(field.id) as { sub_type: string; value: number | null; unit: string | null; state: string; source: string; provenance: string }[];
      const soilHealth = db.conn
        .query("SELECT status, last_error FROM provider_health WHERE provider='soilgrids'")
        .get() as { status: string; last_error: string | null } | undefined;
      const soil = {
        state: soilRows.length > 0 ? "ESTIMATED" : "NO_DATA",
        provider_status: soilHealth?.status ?? "NOT_CONFIGURED",
        properties: soilRows.map((s) => ({ property: s.sub_type, value: s.value, unit: s.unit, state: s.state, source: s.source })),
        note:
          soilRows.length > 0
            ? "SoilGrids v2.0 global model estimates (ESTIMATED — not field measurements)."
            : soilHealth && soilHealth.status !== "AVAILABLE" && soilHealth.status !== "NOT_CONFIGURED"
              ? `No usable soil evidence. SoilGrids provider state: ${soilHealth.status}${soilHealth.last_error ? ` — ${soilHealth.last_error.slice(0, 160)}` : ""}`
              : "No soil evidence recorded.",
      };

      // --- crop (field metadata only; no validated model)
      const crop = {
        state: field.crop_name ? "UNKNOWN" : "UNKNOWN",
        crop_name: field.crop_name ?? null,
        modelled: false,
        note: field.crop_name
          ? `Crop declared as "${field.crop_name}" (farmer field metadata — not independently verified). Procedural plants in the twin are labelled MODELLED.`
          : "No crop declared in field metadata. No crop geometry is rendered and no validated growth model is connected.",
      };

      // --- water (source-gated)
      const waterRows = db.conn.query("SELECT COUNT(*) as n FROM evidence WHERE field_id=? AND domain='water'").get(field.id) as { n: number };
      const waterHealth = db.conn.query("SELECT status FROM provider_health WHERE provider='water-india'").get() as { status: string } | undefined;
      const water = {
        state: waterRows.n > 0 ? "PARTIAL" : waterHealth?.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "NO_DATA",
        note:
          waterRows.n > 0
            ? "Water evidence recorded for this field."
            : "Water intelligence requires a credential-gated data source (India-WRIS/CGWB style). None is configured — no water volume is rendered.",
      };

      // --- sensors (real registered devices only; position = recorded deployment
      // location when the device metadata carries one, else the field centroid
      // with an explicit note — a device is never randomly positioned)
      const devices = db.conn
        .query("SELECT id, name, kind, status, last_seen_at, firmware_version, external_id, metadata FROM devices WHERE field_id=? ORDER BY created_at ASC")
        .all(field.id) as { id: string; name: string; kind: string; status: string; last_seen_at: string | null; firmware_version: string | null; external_id: string | null; metadata: string | null }[];
      const obsCount = db.conn.query("SELECT COUNT(*) as n FROM observations WHERE field_id=?").get(field.id) as { n: number };
      const deviceTelemetry = db.conn
        .query("SELECT device_id, COUNT(*) as n, MAX(observed_at) as last_at FROM observations WHERE field_id=? GROUP BY device_id")
        .all(field.id) as { device_id: string; n: number; last_at: string | null }[];
      const deviceStats = new Map(deviceTelemetry.map((t) => [t.device_id, t]));
      const sensors = {
        state: obsCount.n > 0 ? "OBSERVED" : devices.length > 0 ? "WAITING_FOR_DEVICE" : "NO_DATA",
        devices: devices.map((d) => {
          let meta: { location?: { lat?: unknown; lon?: unknown } } | null = null;
          try {
            meta = d.metadata ? (JSON.parse(d.metadata) as { location?: { lat?: unknown; lon?: unknown } }) : null;
          } catch {
            meta = null;
          }
          const loc = meta?.location;
          const hasLoc = loc && typeof loc.lat === "number" && typeof loc.lon === "number";
          const stat = deviceStats.get(d.id);
          const secs = d.last_seen_at ? Math.max(0, Math.round((Date.now() - new Date(d.last_seen_at).getTime()) / 1000)) : null;
          return {
            id: d.id,
            external_id: d.external_id ?? null,
            name: d.name,
            kind: d.kind,
            status: secs === null ? "registered" : secs <= 120 ? "online" : secs <= 900 ? "stale" : "offline",
            last_seen_at: d.last_seen_at,
            telemetry_count: stat?.n ?? 0,
            last_telemetry_at: stat?.last_at ?? null,
            position: hasLoc ? { lat: loc!.lat as number, lon: loc!.lon as number } : { lat: field.centroid_lat, lon: field.centroid_lon },
            position_note: hasLoc ? "deployment location recorded in device metadata" : "deployment geometry not recorded — marker shown at field centroid",
          };
        }),
        telemetry_observations: obsCount.n,
        note:
          obsCount.n > 0
            ? "Real telemetry has been recorded."
            : devices.length > 0
              ? `${devices.length} registered device(s) with no telemetry yet (WAITING_FOR_DEVICE).`
              : "No devices registered on this field.",
      };

      // --- satellite summary (real acquisitions with metadata, newest first)
      const sat = db.conn.query("SELECT COUNT(*) as n, MAX(acquired_at) as last FROM satellite_products WHERE field_id=?").get(field.id) as { n: number; last: string | null };
      const acquisitions = db.conn
        .query(
          "SELECT id, product_id, satellite, collection, acquired_at, cloud_cover, resolution_m, processing_level, status, source_url FROM satellite_products WHERE field_id=? ORDER BY acquired_at DESC LIMIT 60",
        )
        .all(field.id) as {
        id: string;
        product_id: string;
        satellite: string;
        collection: string;
        acquired_at: string;
        cloud_cover: number | null;
        resolution_m: number | null;
        processing_level: string | null;
        status: string;
        source_url: string | null;
      }[];
      const satellite = {
        state: sat.n > 0 ? "PARTIAL" : "NO_DATA",
        count: sat.n,
        latest_acquisition: sat.last,
        acquisitions,
        note: sat.n > 0 ? "Real STAC product metadata (newest first). Raster/preview access requires Copernicus OAuth credentials (AUTH_REQUIRED)." : "No acquisitions recorded.",
      };

      // --- weather summary (model output)
      const weatherEv = db.conn
        .query(
          "SELECT sub_type, value, unit, state, observed_at FROM evidence WHERE field_id=? AND domain='weather' AND sub_type IN ('current_temperature_2m','current_relative_humidity_2m','current_precipitation','temperature_2m_max','precipitation_sum','et0_fao_evapotranspiration') ORDER BY observed_at DESC LIMIT 6",
        )
        .all(field.id) as { sub_type: string; value: number | null; unit: string | null; state: string; observed_at: string }[];
      const weather = {
        state: weatherEv.length > 0 ? "PARTIAL" : "NO_DATA",
        entries: weatherEv,
        note: "Open-Meteo model output (nowcast/history/forecast) — not physical sensor observations.",
      };

      // --- intelligence (real engine output)
      const risks = db.conn.query("SELECT id, risk_type, level, reason, created_at FROM risks WHERE field_id=? ORDER BY created_at DESC LIMIT 6").all(field.id) as { id: string; risk_type: string; level: string; reason: string; created_at: string }[];
      const anomalies = db.conn.query("SELECT id, kind, severity, description, detected_at FROM anomalies WHERE field_id=? ORDER BY detected_at DESC LIMIT 6").all(field.id) as { id: string; kind: string; severity: string; description: string; detected_at: string }[];
      const investigations = db.conn
        .query("SELECT id, title, status, created_at FROM investigations WHERE field_id=? ORDER BY created_at DESC LIMIT 6")
        .all(field.id) as { id: string; title: string; status: string; created_at: string }[];
      const intelligence = { risks, anomalies, investigations };

      // --- world model summary
      const wm = db.conn
        .query("SELECT trigger, created_at FROM world_model_states WHERE field_id=? ORDER BY created_at DESC LIMIT 1")
        .get(field.id) as { trigger: string; created_at: string } | undefined;

      const rawGeo = field.geometry;
      const geometry = (typeof rawGeo === "string" ? JSON.parse(rawGeo) : rawGeo) as {
        type: "Polygon" | "MultiPolygon";
        coordinates: number[][][][] | number[][][];
      };
      const polygonMeters = geometryToLocalMeters(geometry, field.centroid_lon, field.centroid_lat);

      res.json({
        twin: {
          field: {
            id: field.id,
            name: field.name,
            farm: field.farm_name,
            crop_name: field.crop_name,
            area_m2: field.area_m2,
            centroid: { lat: field.centroid_lat, lon: field.centroid_lon },
            geometry,
            polygon_local_m: polygonMeters,
            truth_note: "Field boundary is user-supplied geometry (DEVELOPMENT_SEED demo seed is labelled as such).",
          },
          layers: { terrain, soil, crop, water, sensors, satellite, weather },
          intelligence,
          world_model: wm ?? null,
          xy_alignment_note: "Twin uses a local ENU projection anchored at the field centroid — the same geometry as the 2D map (lon/lat). Layers may separate only along the vertical axis.",
        },
      });
    } catch (e) {
      next(e);
    }
  });

  return r;
}

interface LocalRing {
  ring: { x: number; z: number }[]; // x = east metres, z = south metres (three.js: x, z plane)
  outer: boolean;
}

/** Convert WGS84 rings to local metres relative to the field centroid (ENU). */
function geometryToLocalMeters(geo: { type: string; coordinates: number[][][][] | number[][][] }, lon0: number, lat0: number): LocalRing[] {
  const rings = geo.type === "Polygon" ? (geo.coordinates as number[][][]) : (geo.coordinates as number[][][][]).flat();
  if (rings.length === 0) return [];
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerDegLat = 111_320;
  return rings.map((ring) => ({
    ring: ring.map(([lon, lat]) => ({
      x: round((lon - lon0) * mPerDegLon, 2),
      z: round(-(lat - lat0) * mPerDegLat, 2), // north points toward -z
    })),
    outer: true,
  }));
}
