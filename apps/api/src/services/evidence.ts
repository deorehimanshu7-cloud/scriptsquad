import type { Domain, EvidenceRecord, Provenance, TruthState } from "contracts";
import type { AppDb } from "../db";
import { nowIso } from "../db";
import { jsonStringify, newId } from "../util";

export interface EvidenceInput {
  userId: string;
  farmId: string;
  fieldId: string;
  domain: Domain;
  source: string;
  source_type: string; // e.g. "sentinel-2-l2a", "open-meteo", "soilgrids", "sensor:soil_moisture", "farmer"
  sub_type: string; // variable / product kind
  measurement: string | null;
  value: number | null;
  unit: string | null;
  state: TruthState;
  observed_at: string;
  retrieved_at?: string;
  quality?: "high" | "medium" | "low" | null;
  quality_reason?: string | null;
  description?: string | null;
  geometry?: unknown;
  provenance: Provenance;
}

/**
 * Single insertion point for evidence. `domain` is explicit per caller:
 * provider adapters never guess domains, so a weather record can never become
 * terrain evidence or vice versa (covered by classification tests).
 */
export function addEvidence(db: AppDb, input: EvidenceInput): EvidenceRecord {
  const id = newId("evid");
  const retrieved = input.retrieved_at ?? nowIso();
  db.conn
    .query(
      `INSERT INTO evidence
       (id, user_id, farm_id, field_id, domain, source, source_type, sub_type, description, measurement, value, unit, state, quality, quality_reason, observed_at, retrieved_at, geometry, provenance, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.userId,
      input.farmId,
      input.fieldId,
      input.domain,
      input.source,
      input.source_type,
      input.sub_type,
      input.description ?? null,
      input.measurement,
      input.value,
      input.unit,
      input.state,
      input.quality ?? null,
      input.quality_reason ?? null,
      input.observed_at,
      retrieved,
      input.geometry ? jsonStringify(input.geometry) : null,
      jsonStringify(input.provenance),
      nowIso(),
    );
  return getEvidence(db, id);
}

export function getEvidence(db: AppDb, id: string): EvidenceRecord {
  const row = db.conn.query("SELECT * FROM evidence WHERE id = ?").get(id) as EvidenceRow | undefined;
  if (!row) throw new Error(`evidence ${id} not found`);
  return mapRow(row);
}

export interface EvidenceRow {
  id: string;
  user_id: string;
  farm_id: string;
  field_id: string;
  domain: string;
  source: string;
  source_type: string;
  sub_type: string;
  description: string | null;
  measurement: string | null;
  value: number | null;
  unit: string | null;
  state: string;
  quality: string | null;
  quality_reason: string | null;
  observed_at: string;
  retrieved_at: string;
  geometry: string | null;
  provenance: string;
  created_at: string;
}

export function mapRow(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    user_id: row.user_id,
    farm_id: row.farm_id,
    field_id: row.field_id,
    domain: row.domain as Domain,
    source: row.source,
    source_type: row.source_type,
    sub_type: row.sub_type,
    description: row.description,
    measurement: row.measurement,
    value: row.value,
    unit: row.unit,
    state: row.state as TruthState,
    quality: row.quality as EvidenceRecord["quality"],
    quality_reason: row.quality_reason,
    observed_at: row.observed_at,
    retrieved_at: row.retrieved_at,
    geometry: row.geometry ? JSON.parse(row.geometry) : null,
    provenance: JSON.parse(row.provenance) as Provenance,
    created_at: row.created_at,
  };
}

export function listEvidence(
  db: AppDb,
  fieldId: string,
  opts: { domain?: string; subType?: string; limit?: number; since?: string; states?: string[] } = {},
): EvidenceRecord[] {
  const clauses = ["field_id = ?"];
  const params: string[] = [fieldId];
  if (opts.domain) {
    clauses.push("domain = ?");
    params.push(opts.domain);
  }
  if (opts.subType) {
    clauses.push("sub_type = ?");
    params.push(opts.subType);
  }
  if (opts.since) {
    clauses.push("observed_at >= ?");
    params.push(opts.since);
  }
  if (opts.states && opts.states.length) {
    clauses.push(`state IN (${opts.states.map(() => "?").join(",")})`);
    params.push(...opts.states);
  }
  const limit = opts.limit ?? 200;
  const rows = db.conn
    .query(`SELECT * FROM evidence WHERE ${clauses.join(" AND ")} ORDER BY observed_at DESC LIMIT ?`)
    .all(...params, String(limit)) as unknown as EvidenceRow[];
  return rows.map(mapRow);
}

export function latestEvidencePerSubtype(db: AppDb, fieldId: string): Map<string, EvidenceRecord> {
  const all = listEvidence(db, fieldId, { limit: 500 });
  const latest = new Map<string, EvidenceRecord>();
  for (const e of all) {
    const key = `${e.domain}:${e.sub_type}`;
    if (!latest.has(key) || e.observed_at > (latest.get(key)?.observed_at ?? "")) latest.set(key, e);
  }
  return latest;
}

export function evidenceCountByDomain(db: AppDb, fieldId: string): Record<string, number> {
  const rows = db.conn
    .query("SELECT domain, COUNT(*) as n FROM evidence WHERE field_id = ? GROUP BY domain")
    .all(fieldId) as { domain: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.domain, r.n]));
}

export function addEvidenceRelationship(
  db: AppDb,
  fieldId: string,
  a: string,
  b: string,
  relationship: "CONTRADICTS" | "SUPPORTS" | "CORROBORATES" | "DERIVED_FROM" | "TEMPORALLY_RELATED" | "SPATIALLY_OVERLAPS",
  reason: string,
): void {
  db.conn
    .query(
      "INSERT OR IGNORE INTO evidence_relationships (id, field_id, evidence_a, evidence_b, relationship, reason, created_at) VALUES (?,?,?,?,?,?,?)",
    )
    .run(newId("rel"), fieldId, a, b, relationship, reason, nowIso());
}

export function deleteEvidenceForField(db: AppDb, fieldId: string): void {
  db.conn.query("DELETE FROM evidence WHERE field_id = ?").run(fieldId);
}

/** Remove evidence rows of one domain (used by idempotent provider refreshes). */
export function deleteEvidenceWhere(db: AppDb, fieldId: string, domain: string): void {
  db.conn.query("DELETE FROM evidence WHERE field_id = ? AND domain = ?").run(fieldId, domain);
}

export interface GraphNode {
  id: string;
  kind: "evidence" | "investigation" | "anomaly" | "risk";
  label: string;
  domain?: string;
  state?: string;
  sub_type?: string;
  value?: number | null;
  unit?: string | null;
  observed_at?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relationship: "CONTRADICTS" | "LINKED_EVIDENCE" | "CITED_BY";
  reason?: string;
}

export interface EvidenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  counts: { evidence: number; investigations: number; anomalies: number; risks: number };
}

/**
 * Evidence graph built from REAL cross-record links only:
 * - CONTRADICTS edges from the contradiction engine (evidence A ↔ B)
 * - investigation → linked evidence edges (investigation_evidence rows)
 * - anomaly / risk → cited evidence edges (evidence_ids arrays)
 * No relationship is invented; if nothing links records the graph is empty.
 */
export function evidenceGraph(db: AppDb, fieldId: string): EvidenceGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();

  const addNode = (n: GraphNode) => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
  };
  const addEdge = (source: string, target: string, relationship: GraphEdge["relationship"], reason?: string) => {
    const key = `${source}->${target}:${relationship}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ source, target, relationship, reason });
  };

  // recent evidence nodes (capped for legibility)
  const recent = listEvidence(db, fieldId, { limit: 80 });
  const evid = new Map(recent.map((e) => [e.id, e]));
  for (const e of recent) {
    addNode({
      id: e.id,
      kind: "evidence",
      label: e.measurement ?? e.sub_type,
      domain: e.domain,
      state: e.state,
      sub_type: e.sub_type,
      value: e.value,
      unit: e.unit,
      observed_at: e.observed_at,
    });
  }

  // contradictions — both sides are real evidence ids
  const contradictions = db.conn
    .query("SELECT evidence_a, evidence_b, reason FROM contradictions WHERE field_id = ?")
    .all(fieldId) as { evidence_a: string; evidence_b: string; reason: string }[];
  for (const c of contradictions) {
    if (!evid.has(c.evidence_a) || !evid.has(c.evidence_b)) continue;
    addEdge(c.evidence_a, c.evidence_b, "CONTRADICTS", c.reason);
  }

  // investigations → linked evidence
  const invRows = db.conn
    .query(
      `SELECT i.id, i.title, ie.evidence_id
       FROM investigations i
       JOIN investigation_evidence ie ON ie.investigation_id = i.id
       WHERE i.field_id = ?`,
    )
    .all(fieldId) as { id: string; title: string; evidence_id: string }[];
  for (const r of invRows) {
    if (!evid.has(r.evidence_id)) continue;
    const invId = `inv:${r.id}`;
    addNode({ id: invId, kind: "investigation", label: r.title });
    addEdge(invId, r.evidence_id, "LINKED_EVIDENCE");
  }

  // anomalies + risks cite evidence ids
  const cited = [
    ...(db.conn
      .query("SELECT id, description, evidence_ids FROM anomalies WHERE field_id = ?")
      .all(fieldId) as { id: string; description: string; evidence_ids: string }[]),
    ...(db.conn
      .query("SELECT id, risk_type, evidence_ids FROM risks WHERE field_id = ?")
      .all(fieldId) as { id: string; risk_type: string; evidence_ids: string }[]),
  ];
  for (const row of cited) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(row.evidence_ids) as string[];
    } catch {
      ids = [];
    }
    const isAnomaly = "description" in row;
    const nodeId = `${isAnomaly ? "anom" : "risk"}:${row.id}`;
    addNode({
      id: nodeId,
      kind: isAnomaly ? "anomaly" : "risk",
      label: isAnomaly ? (row as { description: string }).description : (row as { risk_type: string }).risk_type,
    });
    for (const eid of ids) {
      if (!evid.has(eid)) continue;
      addEdge(nodeId, eid, "CITED_BY");
    }
  }

  return {
    nodes: [...nodes.values()],
    edges,
    counts: {
      evidence: recent.length,
      investigations: new Set(invRows.map((r) => r.id)).size,
      anomalies: db.conn.query("SELECT COUNT(*) AS n FROM anomalies WHERE field_id = ?").get(fieldId) as { n: number } | undefined ? (db.conn.query("SELECT COUNT(*) AS n FROM anomalies WHERE field_id = ?").get(fieldId) as { n: number }).n : 0,
      risks: db.conn.query("SELECT COUNT(*) AS n FROM risks WHERE field_id = ?").get(fieldId) as { n: number } | undefined ? (db.conn.query("SELECT COUNT(*) AS n FROM risks WHERE field_id = ?").get(fieldId) as { n: number }).n : 0,
    },
  };
}
