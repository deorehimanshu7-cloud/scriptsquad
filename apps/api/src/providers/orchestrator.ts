import type { AppDb } from "../db";
import { newId, round } from "../util";
import type { ProviderId, ProviderState } from "contracts";
import { nowIso } from "../db";
import type { ProviderResult } from "./types";
import { PROVIDER_METAS } from "./types";

export interface ProviderCtx {
  db: AppDb;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Orchestrator: wraps every external adapter with request ids, latency
 * capture, error classification, provider health recording and retry with
 * backoff. One provider's failure never propagates to another provider or to
 * the calling pipeline — it returns a ProviderResult with a truthful status.
 */
export async function runProvider<T>(
  ctx: ProviderCtx,
  provider: ProviderId,
  fn: () => Promise<{ data: T; note?: string }>,
  opts: { timeoutMs?: number; retries?: number; fieldId?: string } = {},
): Promise<ProviderResult<T>> {
  const requestId = newId("req");
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 0;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1)); // backoff
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fn();
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      recordHealth(ctx.db, provider, "AVAILABLE", latencyMs, null);
      return {
        provider,
        requestId,
        status: "AVAILABLE",
        retrievedAt: nowIso(),
        latencyMs,
        data: res.data,
        error: null,
        note: res.note,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const status = classifyError(err);
      // retry only for transient network-ish failures
      if (status !== "TIMEOUT" && status !== "PROVIDER_ERROR") break;
    }
  }
  const latencyMs = Date.now() - started;
  const status = classifyError(lastError);
  recordHealth(ctx.db, provider, status, latencyMs, lastError instanceof Error ? lastError.message : String(lastError));
  return {
    provider,
    requestId,
    status,
    retrievedAt: nowIso(),
    latencyMs,
    data: null,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

export function classifyError(err: unknown): ProviderState {
  if (err instanceof AbortErrorLike || (err instanceof Error && err.name === "AbortError")) return "TIMEOUT";
  if (err instanceof Error) {
    const m = err.message;
    if (/401|403|unauthori|forbidden|token/i.test(m)) return "AUTH_REQUIRED";
    if (/429|rate.?limit/i.test(m)) return "RATE_LIMITED";
    if (/timeout|timed out|ETIMEDOUT|abort/i.test(m)) return "TIMEOUT";
    // 5xx = the provider answered but its service is degraded/unusable (e.g.
    // ISRIC's nginx 503 while SoilGrids REST is paused). That is a truthful
    // DATA_QUALITY_FAILURE — the reason (status + body) is kept in the error.
    if (/HTTP 5\d\d/.test(m)) return "DATA_QUALITY_FAILURE";
  }
  return "PROVIDER_ERROR";
}

class AbortErrorLike extends Error {}

export function recordHealth(
  db: AppDb,
  provider: ProviderId,
  status: ProviderState,
  latencyMs: number | null,
  error: string | null,
): void {
  const meta = PROVIDER_METAS[provider];
  db.conn
    .query(
      `INSERT INTO provider_health (provider, status, last_check_at, last_success_at, last_error_at, last_error, latency_ms, auth_state, note)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(provider) DO UPDATE SET
         status = excluded.status,
         last_check_at = excluded.last_check_at,
         last_success_at = CASE WHEN excluded.status = 'AVAILABLE' THEN excluded.last_success_at ELSE provider_health.last_success_at END,
         last_error_at = CASE
           WHEN excluded.status != 'AVAILABLE' THEN excluded.last_error_at
           WHEN provider_health.status IN ('NOT_CONFIGURED','AUTH_REQUIRED') THEN NULL -- initial/seed-era states never count as real history
           ELSE provider_health.last_error_at END,
         last_error = CASE
           WHEN excluded.status != 'AVAILABLE' THEN excluded.last_error
           WHEN provider_health.status IN ('NOT_CONFIGURED','AUTH_REQUIRED') THEN NULL
           ELSE provider_health.last_error END,
         latency_ms = excluded.latency_ms,
         auth_state = excluded.auth_state,
         note = excluded.note`,
    )
    .run(
      provider,
      status,
      nowIso(),
      status === "AVAILABLE" ? nowIso() : null,
      status !== "AVAILABLE" ? nowIso() : null,
      error,
      latencyMs !== null ? round(latencyMs, 0) : null,
      meta.auth_state,
      null,
    );
}

export async function providerHealthSnapshot(db: AppDb): Promise<void> {
  // lightweight pings per configured provider
  const { pingOpenMeteo } = await import("./openmeteo");
  const { pingOpenTopoData } = await import("./opentopodata");
  const { pingCopernicus } = await import("./copernicus");
  const { pingSoilGrids } = await import("./soilgrids");
  const { pingOsmWater } = await import("./osmWater");

  await runProvider({ db }, "openmeteo", async () => ({ data: await pingOpenMeteo() }), { timeoutMs: 10_000 });
  await runProvider({ db }, "opentopodata", async () => ({ data: await pingOpenTopoData() }), { timeoutMs: 15_000 });
  await runProvider({ db }, "copernicus", async () => ({ data: await pingCopernicus() }), { timeoutMs: 10_000 });
  // REST probe (fast fail) + WCS fallback probe may take a few seconds combined.
  await runProvider({ db }, "soilgrids", async () => ({ data: await pingSoilGrids() }), { timeoutMs: 25_000 });
  await runProvider({ db }, "osm-water", async () => ({ data: await pingOsmWater() }), { timeoutMs: 20_000 });

  // credential-gated / unconfigured providers: record their truthful state
  const meta = PROVIDER_METAS;
  if (meta["water-india"].auth_state !== "configured") {
    recordHealth(db, "water-india", "NOT_CONFIGURED", null, "Credentials not configured (India-WRIS/CGWB access requires registration)");
  }
  if (meta.bhoonidhi.auth_state !== "configured") {
    recordHealth(db, "bhoonidhi", "NOT_CONFIGURED", null, "Bhoonidhi/NRSC credentials not configured");
  }
  if (meta.llm.auth_state !== "configured") {
    recordHealth(db, "llm", "AUTH_REQUIRED", null, "No LLM API key configured — assistant uses LOCAL_GROUNDED_FALLBACK");
  }
  recordHealth(db, "sensors", "AVAILABLE", 0, null);

  // MQTT broker — live state is owned by the subscriber; the snapshot re-affirms it.
  const { mqttBrokerHealth } = await import("../services/mqtt");
  mqttBrokerHealth(db);
}

export async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
