import type { EvidenceRecord, RiskLevel } from "contracts";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonStringify, meanStd, newId, percentile } from "../util";
import { getFieldRow } from "./worldModel";
import { listEvidence } from "./evidence";

export interface EngineReport {
  anomalies: number;
  risks: number;
  uncertainties: number;
  contradictions: number;
  actions: number;
  notes: string[];
}

function clearAndInsert<T extends { id: string; field_id: string }>(
  db: AppDb,
  table: string,
  fieldId: string,
  rows: T[],
): void {
  db.conn.query(`DELETE FROM ${table} WHERE field_id = ?`).run(fieldId);
  for (const r of rows) {
    const cols = Object.keys(r).filter((k) => k !== "id");
    const vals = cols.map((c) => (r as Record<string, unknown>)[c] as string | number | null);
    db.conn
      .query(`INSERT INTO ${table} (id, ${cols.join(",")}) VALUES (${["?"].concat(cols.map(() => "?")).join(",")})`)
      .run(r.id, ...vals);
  }
}

interface EngineRow {
  id: string;
  field_id: string;
}

// ---------------------------------------------------------------------------
// ANOMALY ENGINE — statistical anomalies over *actual* recorded evidence only.
// ---------------------------------------------------------------------------
export function runAnomalyEngine(db: AppDb, fieldId: string, notes: string[]): { id: string }[] {
  const field = getFieldRow(db, fieldId);
  if (!field) return [];
  const created: { id: string; kind: string; severity: string }[] = [];
  const rows: (EngineRow & Record<string, unknown>)[] = [];

  // 1) sensor spikes (z-score over the sensor's own real history)
  const sensorTypes = db.conn
    .query("SELECT DISTINCT sensor_type FROM observations WHERE field_id = ?")
    .all(fieldId) as { sensor_type: string }[];
  for (const { sensor_type } of sensorTypes) {
    const obs = db.conn
      .query("SELECT id, value, observed_at FROM observations WHERE field_id = ? AND sensor_type = ? ORDER BY observed_at ASC")
      .all(fieldId, sensor_type) as { id: string; value: number; observed_at: string }[];
    if (obs.length < 4) {
      notes.push(`Anomaly scan for sensor ${sensor_type}: skipped (needs >=4 real observations, has ${obs.length}).`);
      continue;
    }
    const history = obs.slice(0, -1).map((o) => o.value);
    const { mean, std } = meanStd(history);
    if (std <= 0) continue;
    const latest = obs[obs.length - 1];
    const z = Math.abs((latest.value - mean) / std);
    if (z >= 2.5) {
      const severity = z >= 4 ? "high" : z >= 3 ? "medium" : "low";
      const evidence = db.conn
        .query("SELECT id FROM evidence WHERE field_id = ? AND domain='sensor' AND sub_type=? ORDER BY observed_at DESC LIMIT 1")
        .get(fieldId, sensor_type) as { id: string } | undefined;
      const eid = newId("anom");
      const desc = `Sensor ${sensor_type} reading ${latest.value} deviates ${z.toFixed(1)}σ from its own recorded history (mean ${mean.toFixed(2)}, σ ${std.toFixed(2)}).`;
      rows.push({
        id: eid,
        user_id: field.user_id,
        farm_id: field.farm_id,
        field_id: fieldId,
        kind: "sensor_spike",
        severity,
        level: severity,
        description: desc,
        evidence_ids: jsonStringify(evidence ? [evidence.id] : []),
        trigger: `z-score=${z.toFixed(2)} vs own history (n=${history.length})`,
        status: "open",
        detected_at: nowIso(),
        resolved_at: null,
      });
      created.push({ id: eid, kind: "sensor_spike", severity });
    }
  }

  // 2) heavy rainfall (percentile over the field's actual daily record)
  const daily = db.conn
    .query(
      `SELECT observed_at, value FROM evidence WHERE field_id = ? AND domain='weather' AND sub_type='precipitation_sum' ORDER BY observed_at ASC`,
    )
    .all(fieldId) as { observed_at: string; value: number }[];
  if (daily.length >= 10) {
    const sorted = daily.map((d) => d.value).sort((a, b) => a - b);
    const p95 = percentile(sorted, 0.95);
    const recent = daily.slice(-2);
    for (const d of recent) {
      if (d.value >= p95 && p95 > 0) {
        const eid = newId("anom");
        rows.push({
          id: eid,
          user_id: field.user_id,
          farm_id: field.farm_id,
          field_id: fieldId,
          kind: "heavy_rainfall",
          severity: d.value >= percentile(sorted, 0.99) ? "high" : "medium",
          level: d.value >= percentile(sorted, 0.99) ? "high" : "medium",
          description: `Daily precipitation ${d.value} mm on ${d.observed_at.slice(0, 10)} exceeds the 95th percentile (${p95.toFixed(1)} mm) of this field's ${daily.length}-day record.`,
          evidence_ids: jsonStringify([]),
          trigger: `percentile>=95 (record n=${daily.length})`,
          status: "open",
          detected_at: nowIso(),
          resolved_at: null,
        });
        created.push({ id: eid, kind: "heavy_rainfall", severity: "medium" });
      }
    }
  }

  clearAndInsert(db, "anomalies", fieldId, rows as (EngineRow & Record<string, unknown>)[]);
  notes.push(
    rows.length === 0 ? "Anomaly engine: no anomalies detected from current evidence." : `Anomaly engine: ${rows.length} anomaly(s).`,
  );
  return created;
}

// ---------------------------------------------------------------------------
// RISK ENGINE — qualitative levels + explicit reasons tied to evidence.
// ---------------------------------------------------------------------------
export function runRiskEngine(db: AppDb, fieldId: string, notes: string[]): { id: string; risk_type: string; level: RiskLevel }[] {
  const field = getFieldRow(db, fieldId);
  if (!field) return [];
  const rows: (EngineRow & Record<string, unknown>)[] = [];
  const created: { id: string; risk_type: string; level: RiskLevel }[] = [];

  // --- heat stress from real forecast evidence
  const forecastMax = listEvidence(db, fieldId, { domain: "weather", subType: "temperature_2m_max", limit: 30 });
  const next7 = forecastMax.filter((e) => new Date(e.observed_at) > new Date(Date.now() - 12 * 3_600_000));
  const hotDays = next7.filter((e) => (e.value ?? 0) >= 40);
  const warmDays = next7.filter((e) => (e.value ?? 0) >= 35 && (e.value ?? 0) < 40);
  if (next7.length > 0) {
    const level: RiskLevel = hotDays.length > 0 ? "HIGH" : warmDays.length > 0 ? "MEDIUM" : "LOW";
    const reasons: string[] = [];
    if (hotDays.length) reasons.push(`${hotDays.length} forecast day(s) >= 40°C (max ${Math.max(...hotDays.map((d) => d.value ?? 0))}°C).`);
    if (warmDays.length) reasons.push(`${warmDays.length} forecast day(s) 35–40°C.`);
    if (!reasons.length) reasons.push("No forecast day reaches 35°C in the next 7 days.");
    const id = newId("risk");
    rows.push({
      id,
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      risk_type: "heat_stress",
      level,
      reason: reasons.join(" "),
      evidence_ids: jsonStringify(next7.slice(0, 10).map((e) => e.id)),
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    created.push({ id, risk_type: "heat_stress", level });
  } else {
    notes.push("Risk scan (heat): no usable forecast evidence yet.");
  }

  // --- water stress from real ET0 vs precipitation balance + real soil moisture
  const et0 = db.conn
    .query(
      "SELECT id, value, observed_at FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='et0_fao_evapotranspiration' AND observed_at < ? ORDER BY observed_at ASC",
    )
    .all(fieldId, new Date(Date.now() + 24 * 3_600_000).toISOString()) as { id: string; value: number | null; observed_at: string }[];
  const et0Hist = et0.slice(-14); // up to 14 days
  const deficitTotal = et0Hist.reduce((a, e) => a + (e.value ?? 0), 0);
  const recentPrecip = db.conn
    .query(
      "SELECT COALESCE(SUM(value),0) as s FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='precipitation_sum' AND observed_at >= ?",
    )
    .get(fieldId, et0Hist[0]?.observed_at ?? nowIso()) as { s: number };
  const balance = recentPrecip.s - deficitTotal;
  const moisture = db.conn
    .query(
      `SELECT o.value, o.observed_at, o.sensor_type FROM observations o
       WHERE o.field_id=? AND o.sensor_type='soil_moisture' ORDER BY o.observed_at DESC LIMIT 1`,
    )
    .get(fieldId) as { value: number; observed_at: string; sensor_type: string } | undefined;
  if (et0Hist.length >= 3) {
    let level: RiskLevel = "LOW";
    const reasons: string[] = [];
    reasons.push(`Cumulative ET0 over ${et0Hist.length} day(s): ${deficitTotal.toFixed(1)} mm; precipitation same window: ${recentPrecip.s.toFixed(1)} mm; balance ${balance.toFixed(1)} mm.`);
    if (balance < -40) {
      level = "MEDIUM";
      reasons.push("Estimated atmospheric water deficit exceeds 40 mm — irrigation scheduling should be reviewed.");
    }
    // Soil moisture (when a real sensor exists) is ground truth; the ET0/precip
    // balance is only a proxy. Never let the proxy downgrade a sensor-driven
    // elevation: dry soil stays a risk even when recent rain balanced ET0.
    if (moisture) {
      reasons.push(`Latest soil moisture sensor reading: ${moisture.value} at ${moisture.observed_at}.`);
      if (moisture.value < 10 && balance < 0) level = "HIGH";
      else if (moisture.value < 10) level = "MEDIUM";
      else if (moisture.value < 20 && balance < 0) level = "MEDIUM";
      else if (balance < 0) level = "MEDIUM";
      else level = "LOW";
    } else if (level !== "LOW") {
      reasons.push("No soil-moisture sensor connected — water stress level cannot be confirmed (UNKNOWN confidence).");
    } else {
      level = "UNKNOWN";
      reasons.push("No soil-moisture sensor and no meaningful deficit — cannot assess root-zone water status.");
    }
    const id = newId("risk");
    rows.push({
      id,
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      risk_type: "water_stress",
      level,
      reason: reasons.join(" "),
      evidence_ids: jsonStringify(et0Hist.slice(-7).map((e) => e.id).concat(moisture ? [] : [])),
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    created.push({ id, risk_type: "water_stress", level });
  } else {
    const id = newId("risk");
    rows.push({
      id,
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      risk_type: "water_stress",
      level: "UNKNOWN",
      reason: `Insufficient weather history (${et0Hist.length} day(s) of ET0; need >=3) to estimate water stress. No soil-moisture sensor evidence.`,
      evidence_ids: "[]",
      status: "open",
      created_at: nowIso(),
      updated_at: nowIso(),
    });
    created.push({ id, risk_type: "water_stress", level: "UNKNOWN" });
  }

  // --- flood risk follows heavy rainfall anomalies
  const heavy = db.conn
    .query("SELECT id, severity FROM anomalies WHERE field_id=? AND kind='heavy_rainfall' AND status='open'")
    .all(fieldId) as { id: string; severity: string }[];
  const floodLevel: RiskLevel = heavy.some((h) => h.severity === "high") ? "HIGH" : heavy.length ? "MEDIUM" : "LOW";
  const id2 = newId("risk");
  rows.push({
    id: id2,
    user_id: field.user_id,
    farm_id: field.farm_id,
    field_id: fieldId,
    risk_type: "flood",
    level: floodLevel,
    reason:
      heavy.length === 0
        ? "No heavy-rainfall anomalies are open; flood risk assessed LOW."
        : `Open heavy-rainfall anomaly(s) flagged (${heavy.length}). Drainage and waterlogging should be watched.`,
    evidence_ids: jsonStringify(heavy.map((h) => h.id)),
    status: "open",
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  created.push({ id: id2, risk_type: "flood", level: floodLevel });

  // --- sensor reliability (from actual heartbeat/observation gaps)
  const devices = db.conn
    .query("SELECT id, name, status, last_seen_at FROM devices WHERE field_id=?")
    .all(fieldId) as { id: string; name: string; status: string; last_seen_at: string | null }[];
  if (devices.length > 0) {
    const stale = devices.filter(
      (d) => !d.last_seen_at || Date.now() - new Date(d.last_seen_at).getTime() > 2 * 3_600_000,
    );
    if (stale.length === devices.length) {
      const id3 = newId("risk");
      rows.push({
        id: id3,
        user_id: field.user_id,
        farm_id: field.farm_id,
        field_id: fieldId,
        risk_type: "sensor_reliability",
        level: "MEDIUM",
        reason: `All ${devices.length} registered device(s) are stale (no heartbeat within 2h). Sensor-derived evidence may be incomplete.`,
        evidence_ids: "[]",
        status: "open",
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      created.push({ id: id3, risk_type: "sensor_reliability", level: "MEDIUM" });
    } else if (stale.length > 0) {
      notes.push(`Sensor reliability: ${stale.length}/${devices.length} devices stale.`);
    }
  }

  clearAndInsert(db, "risks", fieldId, rows as (EngineRow & Record<string, unknown>)[]);
  notes.push(
    rows.length === 0 ? "Risk engine: insufficient evidence to evaluate any risk." : `Risk engine: ${rows.length} risk item(s) evaluated.`,
  );
  return created;
}

// ---------------------------------------------------------------------------
// ACTION ENGINE — turns MEDIUM/HIGH risks into evidence-linked recommended
// actions (DECISION layer). UNKNOWN/LOW risks get NO action: we never
// recommend acting on insufficient evidence. Existing recommended actions are
// kept so farmer workflow state (taken/verified/dismissed) is never wiped by a
// re-run.
// ---------------------------------------------------------------------------
const ACTION_TEMPLATES: Record<
  string,
  { kind: string; title: string; description: (reason: string) => string }
> = {
  heat_stress: {
    kind: "irrigation",
    title: "Review irrigation for heat-stress days",
    description: (r) => `Heat risk is driven by real forecast evidence — ${r}`,
  },
  water_stress: {
    kind: "irrigation",
    title: "Schedule irrigation to close the water deficit",
    description: (r) => `Water-balance risk is driven by real weather/soil evidence — ${r}`,
  },
  flood: {
    kind: "drainage",
    title: "Check drainage / waterlogging risk",
    description: (r) => `Flood risk is driven by recorded evidence — ${r}`,
  },
  waterlogging: {
    kind: "drainage",
    title: "Check field drainage / waterlogging",
    description: (r) => `Waterlogging risk is driven by recorded evidence — ${r}`,
  },
  sensor_reliability: {
    kind: "maintenance",
    title: "Inspect the flagged sensor",
    description: (r) => `Sensor-reliability risk is driven by telemetry quality — ${r}`,
  },
  disease_pest: {
    kind: "inspection",
    title: "Field inspection for pest/disease signs",
    description: (r) => `Pest/disease risk is driven by recorded evidence — ${r}`,
  },
  nutrient: {
    kind: "soil_test",
    title: "Soil test to confirm nutrient status",
    description: (r) => `Nutrient risk is driven by available evidence — ${r}`,
  },
};

export function runActionEngine(db: AppDb, fieldId: string, notes: string[]): { id: string; risk_id: string }[] {
  const field = getFieldRow(db, fieldId);
  if (!field) return [];
  const risks = db.conn
    .query("SELECT id, risk_type, level, reason FROM risks WHERE field_id=? AND status='open'")
    .all(fieldId) as { id: string; risk_type: string; level: RiskLevel; reason: string }[];
  const created: { id: string; risk_id: string }[] = [];
  for (const r of risks) {
    if (r.level !== "MEDIUM" && r.level !== "HIGH") continue; // UNKNOWN/LOW → nothing actionable
    const existing = db.conn
      .query("SELECT id FROM actions WHERE field_id=? AND recommendation_from=? AND status='recommended'")
      .get(fieldId, r.id);
    if (existing) continue; // preserve workflow state across re-runs
    const tpl = ACTION_TEMPLATES[r.risk_type];
    const id = newId("act");
    db.conn
      .query(
        `INSERT INTO actions (id, user_id, farm_id, field_id, kind, title, description, status, recommendation_from, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'recommended',?,?,?)`,
      )
      .run(
        id,
        field.user_id,
        field.farm_id,
        fieldId,
        tpl?.kind ?? "review",
        tpl?.title ?? `Review ${r.risk_type.replace(/_/g, " ")} risk`,
        tpl ? tpl.description(r.reason) : `Risk evaluated: ${r.reason}`,
        r.id,
        nowIso(),
        nowIso(),
      );
    created.push({ id, risk_id: r.id });
  }
  notes.push(
    created.length > 0
      ? `Action engine: ${created.length} recommendation(s) created from actionable (MEDIUM/HIGH) risks.`
      : "Action engine: no new recommendations (only MEDIUM/HIGH risks get actions; UNKNOWN/LOW get none).",
  );
  return created;
}

// ---------------------------------------------------------------------------
// UNCERTAINTY ENGINE — qualitative, reason-based, no fabricated percentages.
// ---------------------------------------------------------------------------
export function runUncertaintyEngine(db: AppDb, fieldId: string, notes: string[]): { id: string }[] {
  const field = getFieldRow(db, fieldId);
  if (!field) return [];
  const rows: (EngineRow & Record<string, unknown>)[] = [];

  const buckets: { domain: string; label: string; maxAgeH: number; extra?: string }[] = [
    { domain: "weather", label: "weather", maxAgeH: 36 },
    { domain: "satellite", label: "satellite acquisitions", maxAgeH: 24 * 7 },
    { domain: "soil", label: "soil estimates", maxAgeH: 24 * 60 },
    { domain: "terrain", label: "terrain elevation", maxAgeH: 24 * 365 },
    { domain: "sensor", label: "sensor telemetry", maxAgeH: 3 },
    { domain: "water", label: "water evidence", maxAgeH: 24 * 30 },
  ];
  for (const b of buckets) {
    const level = freshnessOf(db, fieldId, b.domain, b.maxAgeH);
    if (level.level === "LOW") continue; // only report genuine uncertainty drivers
    const id = newId("unc");
    rows.push({
      id,
      user_id: field.user_id,
      farm_id: field.farm_id,
      field_id: fieldId,
      kind: level.kind,
      domain: b.domain,
      level: level.level,
      reason: level.reason,
      created_at: nowIso(),
    });
  }

  // spatial limitation: field boundaries may be approximate; no independent verification
  const id2 = newId("unc");
  rows.push({
    id: id2,
    user_id: field.user_id,
    farm_id: field.farm_id,
    field_id: fieldId,
    kind: "spatial_uncertainty",
    domain: null,
    level: "MEDIUM",
    reason: "Field boundary is user-supplied polygon geometry; no ground-survey verification is attached.",
    created_at: nowIso(),
  });

  clearAndInsert(db, "uncertainties", fieldId, rows as (EngineRow & Record<string, unknown>)[]);
  notes.push(
    rows.length === 0 ? "Uncertainty engine: no significant uncertainty drivers found." : `Uncertainty engine: ${rows.length} uncertainty driver(s).`,
  );
  return rows;
}

function freshnessOf(
  db: AppDb,
  fieldId: string,
  domain: string,
  maxAgeH: number,
): { level: "LOW" | "MEDIUM" | "HIGH"; kind: string; reason: string } {
  const last = db.conn
    .query(
      domain === "satellite"
        ? "SELECT MAX(acquired_at) as last FROM satellite_products WHERE field_id = ?"
        : "SELECT MAX(retrieved_at) as last FROM evidence WHERE field_id = ? AND domain = ?",
    )
    .get(fieldId, ...(domain === "satellite" ? [] : [domain])) as { last: string | null } | undefined;
  if (!last?.last) {
    return {
      level: "HIGH",
      kind: "missing_data",
      reason: `No ${domain} evidence exists — the world model has a data gap for ${domain}.`,
    };
  }
  const ageH = (Date.now() - new Date(last.last).getTime()) / 3_600_000;
  if (ageH > maxAgeH) {
    return {
      level: "HIGH",
      kind: "stale_evidence",
      reason: `Last ${domain} evidence is ${Math.round(ageH)}h old (freshness target ${maxAgeH}h).`,
    };
  }
  if (ageH > maxAgeH / 2) {
    return {
      level: "MEDIUM",
      kind: "stale_evidence",
      reason: `Last ${domain} evidence is ${Math.round(ageH)}h old (target ${maxAgeH}h).`,
    };
  }
  return { level: "LOW", kind: "fresh", reason: `${domain} evidence is fresh.` };
}

// ---------------------------------------------------------------------------
// CONTRADICTION ENGINE — only genuine contradictions between recorded evidence.
// ---------------------------------------------------------------------------
export function runContradictionEngine(db: AppDb, fieldId: string, notes: string[]): { id: string }[] {
  const field = getFieldRow(db, fieldId);
  if (!field) return [];
  const rows: (EngineRow & Record<string, unknown>)[] = [];

  // 1) moisture sensor says wet while the atmospheric water balance says deficit
  // Prefer the promoted sensor EVIDENCE row (so the relationship graph can link
  // two evidence records); fall back to raw observations for legacy data.
  const moisture =
    (db.conn
      .query(
        "SELECT id, value, observed_at FROM evidence WHERE field_id=? AND domain='sensor' AND sub_type='soil_moisture' ORDER BY observed_at DESC LIMIT 1",
      )
      .get(fieldId) as { id: string; value: number; observed_at: string } | undefined) ??
    (db.conn
      .query(
        "SELECT id, value, observed_at FROM observations WHERE field_id=? AND sensor_type='soil_moisture' ORDER BY observed_at DESC LIMIT 1",
      )
      .get(fieldId) as { id: string; value: number; observed_at: string } | undefined);
  if (moisture && moisture.value >= 30) {
    const et0rows = db.conn
      .query(
        "SELECT id, value, observed_at FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='et0_fao_evapotranspiration' ORDER BY observed_at ASC",
      )
      .all(fieldId) as { id: string; value: number | null; observed_at: string }[];
    const recent = et0rows.slice(-7);
    const et0sum = recent.reduce((a, e) => a + (e.value ?? 0), 0);
    if (recent.length >= 3 && et0sum - 0 > 30) {
      const precip = db.conn
        .query(
          "SELECT COALESCE(SUM(value),0) as s FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='precipitation_sum' AND observed_at >= ?",
        )
        .get(fieldId, recent[0].observed_at) as { s: number };
      if (precip.s < et0sum - 15) {
        const id = newId("contrad");
        rows.push({
          id,
          user_id: field.user_id,
          farm_id: field.farm_id,
          field_id: fieldId,
          evidence_a: moisture.id,
          evidence_b: recent[recent.length - 1].id,
          relationship: "CONTRADICTS",
          reason: `Soil moisture sensor reports ${moisture.value} (high) while the 7-day ET0−precipitation balance is ${(precip.s - et0sum).toFixed(1)} mm (deficit). Either the sensor, the weather model, or the interpretation is inconsistent.`,
          status: "open",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
        rows.push({
          id: newId("contrad"),
          user_id: field.user_id,
          farm_id: field.farm_id,
          field_id: fieldId,
          evidence_a: moisture.id,
          evidence_b: recent[recent.length - 1].id,
          relationship: "TEMPORALLY_RELATED",
          reason: "Sensor observation and weather window overlap in the same 7-day period.",
          status: "open",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }
    }
  }

  // 2) farmer "no rain" report vs recorded precipitation
  const farmerDry = db.conn
    .query(
      `SELECT f.id, f.text, f.created_at FROM farmer_observations f
       WHERE f.field_id=? AND f.tags LIKE '%reported_no_rain%' ORDER BY f.created_at DESC LIMIT 1`,
    )
    .get(fieldId) as { id: string; text: string; created_at: string } | undefined;
  if (farmerDry) {
    const since = new Date(new Date(farmerDry.created_at).getTime() - 7 * 24 * 3_600_000).toISOString();
    const rain = db.conn
      .query(
        "SELECT COALESCE(SUM(value),0) as s FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='precipitation_sum' AND observed_at >= ?",
      )
      .get(fieldId, since) as { s: number };
    if (rain.s >= 10) {
      // map farmer observation to evidence row if one exists
      const farmerEvidence = db.conn
        .query("SELECT id FROM evidence WHERE field_id=? AND domain='farmer' ORDER BY observed_at DESC LIMIT 1")
        .get(fieldId) as { id: string } | undefined;
      if (farmerEvidence) {
        const id = newId("contrad");
        rows.push({
          id,
          user_id: field.user_id,
          farm_id: field.farm_id,
          field_id: fieldId,
          evidence_a: farmerEvidence.id,
          evidence_b: rainEvidenceId(db, fieldId, since),
          relationship: "CONTRADICTS",
          reason: `Farmer reports no rain while weather records show ${rain.s.toFixed(1)} mm precipitation in the prior week. Possible: mis-report, spatial variability, or a provider discrepancy.`,
          status: "open",
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }
    }
  }

  clearAndInsert(db, "contradictions", fieldId, rows as (EngineRow & Record<string, unknown>)[]);

  // Mirror every engine contradiction into the evidence-relationship graph
  // (CONTRADICTS), so provenance/lineage UIs can walk evidence→evidence links.
  db.conn.query("DELETE FROM evidence_relationships WHERE field_id=? AND relationship='CONTRADICTS'").run(fieldId);
  for (const c of rows as (EngineRow & { evidence_a?: string; evidence_b?: string; reason?: string })[]) {
    if (!c.evidence_a || !c.evidence_b) continue;
    // Only mirror pairs where BOTH ends are real evidence rows: the graph is
    // evidence→evidence (sensor observations / farmer reports that have no
    // evidence row stay visible in the contradictions table, not here).
    const aOk = db.conn.query("SELECT 1 FROM evidence WHERE id=?").get(c.evidence_a);
    const bOk = db.conn.query("SELECT 1 FROM evidence WHERE id=?").get(c.evidence_b);
    if (!aOk || !bOk) continue;
    db.conn
      .query(
        `INSERT OR IGNORE INTO evidence_relationships (id, field_id, evidence_a, evidence_b, relationship, reason, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(newId("rel"), fieldId, c.evidence_a, c.evidence_b, "CONTRADICTS", c.reason ?? "engine-detected contradiction", nowIso());
  }
  notes.push(
    rows.length === 0
      ? "Contradiction engine: no contradictions found between recorded evidence."
      : `Contradiction engine: ${rows.length} contradiction/relationship record(s).`,
  );
  return rows;
}

function rainEvidenceId(db: AppDb, fieldId: string, since: string): string {
  const row = db.conn
    .query("SELECT id FROM evidence WHERE field_id=? AND domain='weather' AND sub_type='precipitation_sum' AND observed_at >= ? ORDER BY observed_at DESC LIMIT 1")
    .get(fieldId, since) as { id: string } | undefined;
  return row?.id ?? "";
}

// ---------------------------------------------------------------------------
export function runIntelligence(db: AppDb, fieldId: string): EngineReport {
  const notes: string[] = [];
  const anomalies = runAnomalyEngine(db, fieldId, notes);
  const risks = runRiskEngine(db, fieldId, notes);
  const uncertainties = runUncertaintyEngine(db, fieldId, notes);
  const contradictions = runContradictionEngine(db, fieldId, notes);
  const actions = runActionEngine(db, fieldId, notes);
  return {
    anomalies: anomalies.length,
    risks: risks.length,
    uncertainties: uncertainties.length,
    contradictions: contradictions.length,
    actions: actions.length,
    notes,
  };
}

export function readEvidence(db: AppDb, ids: string[]): EvidenceRecord[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.conn
    .query(`SELECT * FROM evidence WHERE id IN (${placeholders})`)
    .all(...ids) as never[];
  return rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      farm_id: row.farm_id as string,
      field_id: row.field_id as string,
      domain: row.domain as EvidenceRecord["domain"],
      source: row.source as string,
      source_type: row.source_type as string,
      sub_type: row.sub_type as string,
      description: (row.description as string) ?? null,
      measurement: (row.measurement as string) ?? null,
      value: row.value as number | null,
      unit: row.unit as string | null,
      state: row.state as EvidenceRecord["state"],
      quality: row.quality as EvidenceRecord["quality"],
      quality_reason: (row.quality_reason as string) ?? null,
      observed_at: row.observed_at as string,
      retrieved_at: row.retrieved_at as string,
      geometry: row.geometry ? JSON.parse(row.geometry as string) : null,
      provenance: JSON.parse(row.provenance as string),
      created_at: row.created_at as string,
    };
  });
}
