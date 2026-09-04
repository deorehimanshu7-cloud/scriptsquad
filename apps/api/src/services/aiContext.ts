/**
 * AGRIFUR AI-context service.
 *
 * Builds the structured, field-scoped context that the AI assistant reasons
 * over (and that GET /api/fields/:id/ai-context exposes). Every section keeps
 * its truth state and provenance — nothing is fabricated, and unavailable
 * data stays UNKNOWN / NO_DATA / NOT_CONFIGURED with a reason.
 *
 * The same builder is used by answerForField so the LLM/local fallback and the
 * API endpoint can never drift apart.
 */
import type { AppDb } from "../db";
import { getFieldRow, composeWorldModel } from "./worldModel";
import type { EvidenceRecord } from "contracts";
import { listEvidence } from "./evidence";
import { listMemory } from "./memory";
import { jsonParse, round } from "../util";

// ---------------------------------------------------------------------------
// Sensor freshness
// ---------------------------------------------------------------------------

export type SensorFreshness = "LIVE" | "RECENT" | "STALE" | "OFFLINE" | "UNKNOWN" | "NO_DATA";

/**
 * Classify how current a telemetry timestamp is. Thresholds are explicit so the
 * label is always traceable to a rule (never an invented "live" claim).
 *   < 15 min → LIVE    (actively reporting)
 *   < 2 h    → RECENT  (recent, not live)
 *   < 24 h   → STALE   (no longer current)
 *   ≥ 24 h   → OFFLINE (not reporting)
 *   no ts    → UNKNOWN
 */
export function classifyFreshness(observedAt: string | null | undefined, now: Date = new Date()): SensorFreshness {
  if (!observedAt) return "UNKNOWN";
  const t = new Date(observedAt).getTime();
  if (!Number.isFinite(t)) return "UNKNOWN";
  const minutes = (now.getTime() - t) / 60_000;
  if (minutes < 0) return "UNKNOWN";
  if (minutes < 15) return "LIVE";
  if (minutes < 120) return "RECENT";
  if (minutes < 24 * 60) return "STALE";
  return "OFFLINE";
}

const FRESHNESS_RULE: Record<SensorFreshness, string> = {
  LIVE: "latest observation < 15 min old",
  RECENT: "latest observation 15 min – 2 h old",
  STALE: "latest observation 2–24 h old",
  OFFLINE: "latest observation ≥ 24 h old",
  UNKNOWN: "no timestamp",
  NO_DATA: "no telemetry at all",
};

// ---------------------------------------------------------------------------
// Question → focus routing (question-dependent retrieval)
// ---------------------------------------------------------------------------

export type AiFocus =
  | "sensors"
  | "satellite"
  | "weather"
  | "soil"
  | "water"
  | "terrain"
  | "crop"
  | "intelligence"
  | "all";

/** Domains whose evidence is relevant to a focus. */
export const FOCUS_DOMAINS: Record<Exclude<AiFocus, "all">, string[]> = {
  sensors: ["sensor"],
  satellite: ["satellite", "crop"],
  weather: ["weather"],
  soil: ["soil", "environment"],
  water: ["water"],
  terrain: ["terrain", "environment"],
  crop: ["crop", "satellite"],
  intelligence: ["sensor", "satellite", "weather", "water", "soil", "crop", "terrain"],
};

const FOCUS_RULES: { focus: AiFocus; words: string[] }[] = [
  {
    focus: "sensors",
    words: ["moisture", "ओलावा", "आर्द्रता", "नमी", "sensor", "सेन्सर", "telemetry", "ओला", "कोरडा", "wet", "dry"],
  },
  {
    focus: "water",
    words: ["irrigation", "सिंचन", "सिंचाई", "पाणी", "water", "पाऊस पडला", "groundwater", "भूजल"],
  },
  {
    focus: "weather",
    words: ["weather", "हवामान", "मौसम", "rain", "पाऊस", "वर्षा", "temperature", "तापमान", "heat", "उष्णता", "गरम", "हवा"],
  },
  {
    focus: "satellite",
    words: ["satellite", "उपग्रह", "ndvi", "vegetation", "हिरवे", "हिरवा", "change", "बदल", "काय बदलले", "नकाशा"],
  },
  {
    focus: "crop",
    words: ["crop", "पीक", "फसल", "pest", "कीड", "disease", "रोग", "किड", "ताण", "stress", "पिकाला"],
  },
  {
    focus: "soil",
    words: ["soil", "माती", "मिट्टी", "ph", "fertilizer", "खत", "जमिन"],
  },
  {
    focus: "terrain",
    words: ["terrain", "भूप्रदेश", "elevation", "उंची", "slope", "उतार"],
  },
  {
    focus: "intelligence",
    words: ["risk", "धोका", "जोखिम", "anomaly", "विसंगती", "सल्ला", "काय करू", "काय करावे", "advice", "recommend"],
  },
];

/** Route a farmer question (en/hi/mr) to the evidence focus that answers it. */
export function questionFocus(question: string): AiFocus {
  const q = question.toLowerCase();
  for (const rule of FOCUS_RULES) {
    if (rule.words.some((w) => q.includes(w.toLowerCase()))) return rule.focus;
  }
  return "all";
}

// ---------------------------------------------------------------------------
// Context builder
// ---------------------------------------------------------------------------

export interface AiContextOptions {
  focus?: AiFocus;
  /** max evidence entries per domain */
  perDomain?: number;
  /** max intelligence rows per kind */
  intelLimit?: number;
}

export interface AiContextPayload {
  field: Record<string, unknown>;
  farm: Record<string, unknown> | null;
  sensors: {
    state: SensorFreshness;
    reason: string;
    freshness_rule: string;
    latest_at: string | null;
    devices: Record<string, unknown>[];
    observations: Record<string, unknown>[];
  };
  satellite: { state: string; reason: string; latest: Record<string, unknown> | null; best: Record<string, unknown> | null; products: Record<string, unknown>[] };
  weather: { state: string; summary: string | null; entries: Record<string, unknown>[] };
  soil: { state: string; summary: string | null; entries: Record<string, unknown>[] };
  water: { state: string; summary: string | null; entries: Record<string, unknown>[] };
  terrain: { state: string; summary: string | null; entries: Record<string, unknown>[] };
  crop: { state: string; crop_name: string | null; entries: Record<string, unknown>[] };
  intelligence: {
    anomalies: Record<string, unknown>[];
    risks: Record<string, unknown>[];
    uncertainties: Record<string, unknown>[];
    contradictions: Record<string, unknown>[];
  };
  world_model: { domains: Record<string, unknown>[] };
  memory: Record<string, unknown>[];
  focus: AiFocus;
  provenance: { schema_version: number; generated_at: string; field_id: string };
}

function evEntry(e: EvidenceRecord): Record<string, unknown> {
  return {
    id: e.id,
    domain: e.domain,
    sub_type: e.sub_type,
    description: e.description,
    value: e.value,
    unit: e.unit,
    state: e.state,
    quality: e.quality,
    quality_reason: e.quality_reason,
    observed_at: e.observed_at,
    source: e.source,
    provenance: e.provenance ?? null,
  };
}

export function buildAiContext(db: AppDb, fieldId: string, opts: AiContextOptions = {}): AiContextPayload {
  const field = getFieldRow(db, fieldId);
  const focus = opts.focus ?? "all";
  const perDomain = opts.perDomain ?? 6;
  const intelLimit = opts.intelLimit ?? 5;
  if (!field) {
    throw new Error("field not found");
  }

  const farm =
    (db.conn.query("SELECT id, name, location_name FROM farms WHERE id = ?").get(field.farm_id) as Record<string, unknown> | undefined) ?? null;

  // ---- sensors -----------------------------------------------------------
  const devices = db.conn
    .query("SELECT id, name, kind, firmware_version, status, last_seen_at FROM devices WHERE field_id = ? ORDER BY created_at ASC")
    .all(fieldId) as Record<string, unknown>[];
  const obsRows = db.conn
    .query(
      "SELECT id, device_id, sensor_type, value, unit, observed_at, quality, calibration_version FROM observations WHERE field_id = ? ORDER BY observed_at DESC LIMIT 300",
    )
    .all(fieldId) as Record<string, unknown>[];

  let sensorState: SensorFreshness;
  let sensorReason: string;
  let latestAt: string | null = null;
  if (devices.length === 0) {
    sensorState = "NO_DATA";
    sensorReason = "No sensor devices are registered for this field.";
  } else if (obsRows.length === 0) {
    sensorState = "UNKNOWN";
    sensorReason = `${devices.length} device(s) registered but no telemetry has been received yet (WAITING_FOR_DEVICE).`;
  } else {
    latestAt = String(obsRows[0].observed_at);
    sensorState = classifyFreshness(latestAt);
    sensorReason = `Latest telemetry received at ${latestAt} — ${FRESHNESS_RULE[sensorState]}. ${
      sensorState === "STALE" || sensorState === "OFFLINE"
        ? "The sensor is not currently reporting; do not present this value as live."
        : ""
    }`;
  }
  const latestPerDevice = new Map<string, Record<string, unknown>>();
  for (const row of obsRows) {
    const key = `${String(row.device_id)}::${String(row.sensor_type)}`;
    if (!latestPerDevice.has(key)) latestPerDevice.set(key, row);
  }
  const observations = [...latestPerDevice.values()].map((o) => ({
    ...o,
    state: "OBSERVED", // physical telemetry is an observation by definition
    freshness: classifyFreshness(String(o.observed_at)),
  }));

  // ---- satellite ---------------------------------------------------------
  const products = db.conn
    .query(
      "SELECT id, provider, satellite, product_id, collection, acquired_at, cloud_cover, resolution_m, processing_level, polarization, product_type, state, status, source_url FROM satellite_products WHERE field_id = ? ORDER BY acquired_at DESC LIMIT 20",
    )
    .all(fieldId) as Record<string, unknown>[];
  const latest = products[0] ?? null;
  const best = [...products].sort((a, b) => Number(a.cloud_cover ?? 100) - Number(b.cloud_cover ?? 100))[0] ?? null;
  const satState = products.length === 0 ? "NO_DATA" : "OBSERVED";

  // ---- evidence domains --------------------------------------------------
  const domainBlock = (domain: string, worldDomains: Record<string, unknown>[]): { state: string; summary: string | null; entries: Record<string, unknown>[] } => {
    const wd = worldDomains.find((d) => d.domain === domain) as Record<string, unknown> | undefined;
    const entries = listEvidence(db, fieldId, { domain, limit: perDomain }).map(evEntry);
    return {
      state: String(wd?.state ?? (entries.length ? "OBSERVED" : "NO_DATA")),
      summary: (wd?.summary as string | null) ?? null,
      entries,
    };
  };

  const { domains } = composeWorldModel(db, fieldId);
  const worldDomains = domains as unknown as Record<string, unknown>[];

  // ---- intelligence ------------------------------------------------------
  const q = (sql: string, limit: number): Record<string, unknown>[] =>
    db.conn.query(sql).all(fieldId, String(limit)) as Record<string, unknown>[];

  // ---- memory ------------------------------------------------------------
  const memory = listMemory(db, fieldId, 10) as Record<string, unknown>[];

  const payload: AiContextPayload = {
    field: {
      id: field.id,
      name: field.name,
      crop_name: field.crop_name,
      centroid_lat: round(field.centroid_lat, 6),
      centroid_lon: round(field.centroid_lon, 6),
      area_m2: field.area_m2,
      bbox: typeof field.bbox === "string" ? jsonParse(field.bbox, null) : (field.bbox ?? null),
      farm_id: field.farm_id,
    },
    farm,
    sensors: {
      state: sensorState,
      reason: sensorReason,
      freshness_rule: FRESHNESS_RULE[sensorState],
      latest_at: latestAt,
      devices,
      observations,
    },
    satellite: {
      state: satState,
      reason: products.length === 0 ? "No satellite products discovered for this field yet (run the pipeline / satellite refresh)." : `${products.length} real product(s) in the catalog — metadata is OBSERVED, raster previews may be AUTH_REQUIRED.`,
      latest,
      best,
      products: products.slice(0, 8),
    },
    weather: domainBlock("weather", worldDomains),
    soil: domainBlock("soil", worldDomains),
    water: domainBlock("water", worldDomains),
    terrain: domainBlock("terrain", worldDomains),
    crop: {
      ...domainBlock("crop", worldDomains),
      crop_name: field.crop_name,
    },
    intelligence: {
      anomalies: q(
        "SELECT id, kind, severity, level, description, trigger, status, detected_at FROM anomalies WHERE field_id = ? AND status IN ('open','investigating') ORDER BY detected_at DESC LIMIT ?",
        intelLimit,
      ),
      risks: q("SELECT id, risk_type, level, reason, status, created_at FROM risks WHERE field_id = ? AND status IN ('open','mitigating') ORDER BY created_at DESC LIMIT ?", intelLimit),
      uncertainties: q("SELECT id, kind, domain, level, reason, created_at FROM uncertainties WHERE field_id = ? ORDER BY created_at DESC LIMIT ?", intelLimit),
      contradictions: q(
        "SELECT id, evidence_a, evidence_b, relationship, reason, status, created_at FROM contradictions WHERE field_id = ? AND status IN ('open','investigating') ORDER BY created_at DESC LIMIT ?",
        intelLimit,
      ),
    },
    world_model: {
      domains: worldDomains.map((d) => ({
        domain: d.domain,
        state: d.state,
        count: d.count,
        summary: d.summary,
      })),
    },
    memory,
    focus,
    provenance: {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      field_id: fieldId,
    },
  };
  return payload;
}

// ---------------------------------------------------------------------------
// Prompt-ready normalisation (used by answerForField)
// ---------------------------------------------------------------------------

/**
 * Reduce the full context to the evidence relevant to a question focus.
 * Returns a compact text block with every value labelled by truth state.
 */
export function aiContextForPrompt(
  ctx: AiContextPayload,
  opts: { includeAllDomains?: boolean } = {},
): { domains: string[]; evidence: string[]; sensorBlock: string; satelliteBlock: string; intelBlock: string } {
  const focusDomains = ctx.focus === "all" ? null : (FOCUS_DOMAINS[ctx.focus as Exclude<AiFocus, "all">] ?? null);
  const domainLines = ctx.world_model.domains
    .filter((d) => (opts.includeAllDomains || focusDomains === null ? true : focusDomains.includes(String(d.domain))))
    .map((d) => `- ${d.domain}: ${d.state} (${d.count} item(s)) — ${d.summary}`);
  const evLines: string[] = [];
  for (const sec of [ctx.weather, ctx.soil, ctx.water, ctx.terrain, ctx.crop] as { entries: Record<string, unknown>[] }[]) {
    for (const e of sec.entries) {
      if (focusDomains && !focusDomains.includes(String(e.domain))) continue;
      evLines.push(`- ${e.domain}/${e.sub_type} = ${e.value ?? "—"} ${e.unit ?? ""} [${e.state}] at ${String(e.observed_at).slice(0, 10)} (${e.source})`);
    }
  }
  const sensorBlock = [
    `- sensor state: ${ctx.sensors.state} — ${ctx.sensors.reason}`,
    ...ctx.sensors.observations.map(
      (o) => `- ${o.sensor_type} = ${o.value} ${o.unit ?? ""} [OBSERVED, freshness ${o.freshness}] at ${String(o.observed_at).slice(0, 19)} (device ${o.device_id}, quality ${o.quality ?? "unset"})`,
    ),
  ].join("\n");
  const satelliteBlock = ctx.satellite.latest
    ? `- satellite: ${ctx.satellite.latest.satellite} ${ctx.satellite.latest.processing_level ?? ""} acquired ${String(ctx.satellite.latest.acquired_at).slice(0, 10)} cloud ${ctx.satellite.latest.cloud_cover ?? "?"}% — metadata OBSERVED${ctx.satellite.best && ctx.satellite.best.id !== ctx.satellite.latest.id ? `; best qualified: ${String(ctx.satellite.best.acquired_at).slice(0, 10)} (cloud ${ctx.satellite.best.cloud_cover ?? "?"}%)` : ""}`
    : "- satellite: NO_DATA — no acquisition catalogued for this field yet";
  const intelBlock = [
    ...ctx.intelligence.risks.map((r) => `- risk ${r.risk_type}: ${r.level} — ${r.reason}`),
    ...ctx.intelligence.anomalies.map((a) => `- anomaly ${a.kind}: ${a.description}`),
    ...ctx.intelligence.contradictions.map((c) => `- contradiction: ${c.reason}`),
  ].join("\n");
  return { domains: domainLines, evidence: evLines, sensorBlock, satelliteBlock, intelBlock };
}