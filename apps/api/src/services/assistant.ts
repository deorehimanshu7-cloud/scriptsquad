import type { AppDb } from "../db";
import { nowIso } from "../db";
import { config } from "../config";
import { jsonParse, jsonStringify, newId, round } from "../util";
import { getFieldRow, composeWorldModel } from "./worldModel";
import type { AssistantAnswer, AssistantMessage } from "contracts";
import { buildAiContext, questionFocus, aiContextForPrompt, FOCUS_DOMAINS, type AiContextPayload, type AiFocus } from "./aiContext";

/**
 * Grounded assistant. Two modes:
 *  - LLM:     uses the configured model provider with a strict system prompt that
 *             forbids inventing data; the model is only allowed to reason over the
 *             evidence we attach.
 *  - LOCAL_GROUNDED_FALLBACK: deterministic summary of the field's actual world
 *             model. Never fabricates values, risk scores or confidence numbers.
 *
 * Both modes always label every number with its truth state. If the provider is
 * not configured the answer mode is AUTH_REQUIRED.
 */
export async function answerForField(
  db: AppDb,
  fieldId: string,
  question: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
): Promise<AssistantAnswer> {
  const field = getFieldRow(db, fieldId);
  if (!field) {
    return {
      answer: "Field not found.",
      mode: "LOCAL_GROUNDED_FALLBACK",
      evidence: [],
      uncertainty: "Field does not exist in this account.",
      next_action: null,
    };
  }

  // Question-dependent retrieval: only the evidence relevant to the question
  // is sent to the reasoning layer (sensor question → sensor evidence only,
  // irrigation → water + weather + sensors, change → satellite + history …).
  const focus = questionFocus(question);
  const ctx = buildAiContext(db, fieldId, { focus, perDomain: 6, intelLimit: 4 });
  const focused = aiContextForPrompt(ctx);
  const context: LlmContext = {
    field: ctx.field,
    focus,
    domains: focused.domains,
    sensors: focused.sensorBlock,
    satellite: focused.satelliteBlock,
    intelligence: focused.intelBlock,
    evidence: focused.evidence,
  };

  const focusDomains = ctx.focus === "all" ? null : (FOCUS_DOMAINS[ctx.focus as Exclude<AiFocus, "all">] ?? null);
  const uncertainty =
    ctx.world_model.domains
      .filter((d) => (focusDomains === null || focusDomains.includes(String(d.domain))))
      .filter((d) => ["NO_DATA", "NOT_CONFIGURED", "AUTH_REQUIRED", "UNKNOWN"].includes(String(d.state)))
      .map((d) => `${d.domain}=${d.state}`)
      .join(", ") || "none";

  const evidenceRefs = ctxToEvidenceRefs(ctx);

  if (!config.llm.apiKey) {
    return {
      answer: localAnswer(context, question),
      mode: "LOCAL_GROUNDED_FALLBACK",
      evidence: evidenceRefs,
      uncertainty,
      next_action: "Add an LLM API key to enable conversational reasoning. Current answer is a deterministic summary of recorded evidence only.",
    };
  }

  try {
    const llmAnswer = await callLlm(context, question, history);
    return { ...llmAnswer, evidence: evidenceRefs, uncertainty };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      answer: `The language model provider failed (${message}). Falling back to a deterministic summary of recorded evidence.\n\n${localAnswer(context, question)}`,
      mode: "LOCAL_GROUNDED_FALLBACK",
      evidence: evidenceRefs,
      uncertainty,
      next_action: "Check the LLM provider configuration.",
    };
  }
}

function localAnswer(context: LlmContext, question: string): string {
  const field = (context.field as { name?: string } | null) ?? null;
  const head = `Grounded summary for field "${field?.name ?? "this field"}" (local evidence-only mode — no language model configured):\n`;
  const domainLines = context.domains.map((d) => `• ${d}`).join("\n");
  const evidenceLines = context.evidence.map((e) => `• ${e}`).join("\n");
  return `${head}\n\nWorld model (focus: ${context.focus}):\n${domainLines}\n\nSensors:\n${context.sensors}\n\nSatellite:\n${context.satellite}\n\nIntelligence:\n${context.intelligence}\n\nRelevant evidence:\n${evidenceLines}\n\nQuestion: "${question}"\n\nI can only report what is actually recorded. Every value above carries its truth state ([OBSERVED]/[DERIVED]/[ESTIMATED]/[PREDICTED]/[HISTORICAL]/[SIMULATED]/[UNKNOWN]). Anything not listed is UNKNOWN — the system never fills gaps with assumed values.`;
}

interface LlmContext {
  field: unknown;
  focus: string;
  domains: string[];
  sensors: string;
  satellite: string;
  intelligence: string;
  evidence: string[];
}

function ctxToEvidenceRefs(ctx: AiContextPayload): { id: string; domain: string; sub_type: string; state: string }[] {
  const refs: { id: string; domain: string; sub_type: string; state: string }[] = [];
  for (const e of ctx.sensors.observations) {
    refs.push({ id: String(e.id), domain: "sensor", sub_type: String(e.sensor_type), state: "OBSERVED" });
  }
  for (const sec of [ctx.weather, ctx.soil, ctx.water, ctx.terrain, ctx.crop] as { entries: Record<string, unknown>[] }[]) {
    for (const e of sec.entries) refs.push({ id: String(e.id), domain: String(e.domain), sub_type: String(e.sub_type), state: String(e.state) });
  }
  return refs.slice(0, 12);
}

async function callLlm(
  context: LlmContext,
  question: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<Omit<AssistantAnswer, "uncertainty">> {
  const system = [
    "You are AGRIFUR2, a grounded agricultural intelligence assistant.",
    "You are given a field's world model and a subset of its recorded evidence.",
    "STRICT RULES:",
    "1. Never invent sensor readings, weather observations, satellite acquisitions, soil values, risk scores, confidence percentages or probabilities.",
    "2. Every number you cite must carry its truth state label: OBSERVED, DERIVED, ESTIMATED, HISTORICAL, PREDICTED, SIMULATED or UNKNOWN.",
    "3. If a domain is NO_DATA, NOT_CONFIGURED, AUTH_REQUIRED or UNKNOWN, say so explicitly instead of assuming.",
    "4. Do not convert evidence coverage or freshness into confidence percentages.",
    "5. Answer concisely for a farmer, in plain language.",
  ].join("\n");
  const user = `Field context (focus: ${context.focus}):\n${JSON.stringify(context, null, 2)}\n\nFarmer question: ${question}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          ...history.slice(-8),
          { role: "user", content: user },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`LLM HTTP ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const answer = data.choices?.[0]?.message?.content?.trim() ?? "No answer returned by the model.";
    return {
      answer,
      mode: "LLM",
      evidence: [], // refs are attached by answerForField so both modes carry identical provenance
      next_action: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Session + message persistence
// ---------------------------------------------------------------------------
export function listSessions(db: AppDb, userId: string, fieldId?: string | null): unknown[] {
  const rows = fieldId
    ? db.conn
        .query("SELECT id, field_id, title, created_at, updated_at FROM assistant_sessions WHERE user_id = ? AND field_id = ? ORDER BY updated_at DESC LIMIT 50")
        .all(userId, fieldId)
    : db.conn
        .query("SELECT id, field_id, title, created_at, updated_at FROM assistant_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50")
        .all(userId);
  return rows;
}

export function createSession(db: AppDb, userId: string, fieldId: string | null, title: string): string {
  const id = newId("asess");
  db.conn
    .query("INSERT INTO assistant_sessions (id, user_id, field_id, title, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run(id, userId, fieldId, title ?? "New session", nowIso(), nowIso());
  return id;
}

export function getSession(db: AppDb, userId: string, sessionId: string): { id: string; field_id: string | null; title: string } | null {
  const row = db.conn
    .query("SELECT id, field_id, title FROM assistant_sessions WHERE id = ? AND user_id = ?")
    .get(sessionId, userId) as { id: string; field_id: string | null; title: string } | undefined;
  return row ?? null;
}

export function sessionMessages(db: AppDb, sessionId: string): AssistantMessage[] {
  const rows = db.conn
    .query("SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 100")
    .all(sessionId) as unknown as (AssistantMessage & { meta: string })[];
  return rows.map((r) => ({ ...r, meta: jsonParse(r.meta, null) }));
}

export function appendMessage(
  db: AppDb,
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  meta: unknown = null,
): void {
  db.conn
    .query("INSERT INTO assistant_messages (id, session_id, role, content, meta, created_at) VALUES (?,?,?,?,?,?)")
    .run(newId("amsg"), sessionId, role, content, meta ? jsonStringify(meta) : null, nowIso());
  db.conn.query("UPDATE assistant_sessions SET updated_at = ? WHERE id = ?").run(nowIso(), sessionId);
}

export function fieldSummaryForAssistant(db: AppDb, fieldId: string): string {
  const field = getFieldRow(db, fieldId);
  if (!field) return "Field not found.";
  const { snapshot } = composeWorldModel(db, fieldId);
  const domains = (snapshot.domains ?? []) as { domain: string; state: string; summary: string }[];
  const areaHa = field.area_m2 ? round(field.area_m2 / 10_000, 2) : null;
  return [
    `Field "${field.name}" (${areaHa ? `${areaHa} ha` : "area unknown"} at ${round(field.centroid_lat, 5)}, ${round(field.centroid_lon, 5)}).`,
    ...domains.map((d) => `- ${d.domain}: ${d.state} — ${d.summary}`),
  ].join("\n");
}