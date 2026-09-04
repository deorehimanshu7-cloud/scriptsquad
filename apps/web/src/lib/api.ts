import type {
  ActionRecord,
  AnomalyRecord,
  AssistantAnswer,
  AssistantMessage,
  AssistantSession,
  ContradictionRecord,
  DeviceRecord,
  EvidenceRecord,
  EvidenceRelationship,
  FarmRecord,
  FarmerObservation,
  FieldRecord,
  Investigation,
  JobRecord,
  MemoryEntry,
  ObservationRow,
  ProviderMeta,
  RiskRecord,
  SatelliteProduct,
  SimulationRecord,
  SystemEvent,
  UncertaintyRecord,
  UserRecord,
  VerificationRecord,
} from "./types";

const TOKEN_KEY = "agrifur_token";
const USER_KEY = "agrifur_user";

// API origin for split-hosting (SPA on a static host, API on a persistent
// host). Order: runtime global (window.__AGRIFUR_API__) → build-time
// VITE_API_URL → same-origin. Empty = call /api on this origin.
const __buildApiUrl = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").trim();
const __runtimeApiUrl =
  (typeof window !== "undefined"
    ? (window as Window & { __AGRIFUR_API__?: string }).__AGRIFUR_API__
    : undefined) ?? "";
const API_ORIGIN = (__runtimeApiUrl || __buildApiUrl).replace(/\/+$/, "");
const apiUrl = (path: string): string => `${API_ORIGIN}/api${path}`;

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getStoredUser(): UserRecord | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as UserRecord) : null;
  } catch {
    return null;
  }
}
export function setStoredUser(u: UserRecord | null): void {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiUrl(path), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
  if (!res.ok) {
    // A non-JSON error body means this origin is NOT running the AGRIFUR API
    // (typical on static-only hosts: they answer GETs with the SPA and reject
    // POSTs with 405). Surface that clearly instead of a raw status code.
    if (data === null) {
      throw new ApiError(
        res.status,
        "API_UNREACHABLE",
        "Backend API is not running at this address. Deploy the full-stack server (docker compose up -d --build, see docs/DEPLOYMENT.md) or set the API origin, then reload.",
        { status: res.status, note: "response was not the AGRIFUR API JSON envelope" },
      );
    }
    throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  }
  return data as T;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const authApi = {
  register: (name: string, email: string, password: string) =>
    request<{ user: UserRecord; token: string }>("/auth/register", { method: "POST", body: { name, email, password }, auth: false }),
  login: (email: string, password: string) =>
    request<{ user: UserRecord; token: string }>("/auth/login", { method: "POST", body: { email, password }, auth: false }),
  me: () => request<{ authenticated: true; user: UserRecord }>("/auth/me"),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  /** Development-only signal: is the seeded demo account present in this database? */
  demo: () =>
    request<{ available: boolean; email: string | null; note: string }>("/auth/demo", { auth: false }),
};

// ---------------------------------------------------------------------------
// Farms & fields
// ---------------------------------------------------------------------------
export const farmApi = {
  listFarms: () => request<{ farms: FarmRecord[] }>("/farms"),
  createFarm: (name: string, location_name?: string) =>
    request<{ farm: FarmRecord }>("/farms", { method: "POST", body: { name, location_name: location_name ?? null } }),
  listFields: () => request<{ fields: FieldRecord[] }>("/fields"),
  createField: (body: { farm_id: string; name: string; crop_name?: string | null; geometry: unknown }) =>
    request<{ field: FieldRecord }>("/fields", { method: "POST", body }),
  getField: (id: string) => request<{ field: FieldRecord }>(`/fields/${id}`),
  patchField: (id: string, body: { name?: string; crop_name?: string | null }) =>
    request<{ field: FieldRecord }>(`/fields/${id}`, { method: "PATCH", body }),
  deleteField: (id: string) => request<{ ok: true }>(`/fields/${id}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// World model & evidence
// ---------------------------------------------------------------------------
export const worldApi = {
  evidence: (fieldId: string, q: { domain?: string; sub_type?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.domain) params.set("domain", q.domain);
    if (q.sub_type) params.set("sub_type", q.sub_type);
    if (q.limit) params.set("limit", String(q.limit));
    const qs = params.toString();
    return request<{ evidence: EvidenceRecord[] }>(`/fields/${fieldId}/evidence${qs ? `?${qs}` : ""}`);
  },
  worldModel: (fieldId: string) =>
    request<{ world_model: { id: string; snapshot: Record<string, unknown>; trigger: string; created_at: string } | null }>(`/fields/${fieldId}/world-model`),
  worldModelHistory: (fieldId: string) => request<{ history: { id: string; created_at: string; trigger: string; changed_domains: string[] }[] }>(`/fields/${fieldId}/world-model/history`),
  memory: (fieldId: string) => request<{ memory: MemoryEntry[] }>(`/fields/${fieldId}/memory`),
  analyze: (fieldId: string) =>
    request<{ report: { anomalies: number; risks: number; uncertainties: number; contradictions: number; actions: number; notes: string[] } }>(
      `/fields/${fieldId}/analyze`,
      { method: "POST" },
    ),
  /** Run the same backend pipeline the worker uses (weather → satellite → soil → terrain → world model → intelligence). */
  refresh: (fieldId: string) =>
    request<{ ok: true; field_id: string; note: string }>(`/fields/${fieldId}/refresh`, { method: "POST" }),
  digitalTwin: (fieldId: string) => request<{ twin: Record<string, unknown> }>(`/fields/${fieldId}/digital-twin`),
};

// ---------------------------------------------------------------------------
// Intelligence
// ---------------------------------------------------------------------------
export const intelApi = {
  anomalies: (fieldId: string) => request<{ anomalies: AnomalyRecord[] }>(`/fields/${fieldId}/anomalies`),
  risks: (fieldId: string) => request<{ risks: RiskRecord[] }>(`/fields/${fieldId}/risks`),
  uncertainties: (fieldId: string) => request<{ uncertainties: UncertaintyRecord[] }>(`/fields/${fieldId}/uncertainties`),
  contradictions: (fieldId: string) => request<{ contradictions: ContradictionRecord[] }>(`/fields/${fieldId}/contradictions`),
  actions: (fieldId: string) => request<{ actions: ActionRecord[] }>(`/fields/${fieldId}/actions`),
  verifications: (fieldId: string) => request<{ verifications: VerificationRecord[] }>(`/fields/${fieldId}/verifications`),
  relationships: (fieldId: string) =>
    request<{ relationships: EvidenceRelationship[] }>(`/fields/${fieldId}/evidence/relationships`),
  setActionStatus: (
    fieldId: string,
    actionId: string,
    body: { status: "taken" | "verified" | "dismissed"; outcome?: string | null },
  ) =>
    request<{ ok: true; action: { id: string; status: string }; verification_id: string | null }>(
      `/fields/${fieldId}/actions/${actionId}/status`,
      { method: "POST", body },
    ),
  intelligence: (fieldId: string) =>
    request<{ anomalies: AnomalyRecord[]; risks: RiskRecord[]; uncertainties: UncertaintyRecord[]; contradictions: ContradictionRecord[] }>(
      `/fields/${fieldId}/intelligence`,
    ),
  listInvestigations: (fieldId: string) => request<{ investigations: Investigation[] }>(`/fields/${fieldId}/investigations`),
  createInvestigation: (fieldId: string, body: { title: string; problem: string; trigger?: string; evidence_ids?: string[]; auto?: boolean }) =>
    request<{ investigation: Investigation }>(`/fields/${fieldId}/investigations`, { method: "POST", body }),
  getInvestigation: (id: string) => request<{ investigation: Investigation }>(`/investigations/${id}`),
  patchInvestigation: (id: string, body: { status?: string; conclusion?: string | null }) =>
    request<{ investigation: Investigation }>(`/investigations/${id}`, { method: "PATCH", body }),
  addHypothesis: (id: string, statement: string) =>
    request<{ investigation: Investigation }>(`/investigations/${id}/hypotheses`, { method: "POST", body: { statement } }),
  setHypothesis: (id: string, hypId: string, status: string) =>
    request<{ investigation: Investigation }>(`/investigations/${id}/hypotheses/${hypId}`, { method: "PATCH", body: { status } }),
  autoInvestigate: (fieldId: string) =>
    request<{ investigation: Investigation }>(`/fields/${fieldId}/investigations/auto`, { method: "POST" }),
};

// ---------------------------------------------------------------------------
// Satellite
// ---------------------------------------------------------------------------
export const spaceApi = {
  products: (fieldId: string) => request<{ products: SatelliteProduct[] }>(`/fields/${fieldId}/satellite/products`),
  summary: (fieldId: string) =>
    request<{
      summary: {
        total: number;
        collections: { collection: string; n: number }[];
        optical: number;
        sar: number;
        latest_acquisition: SatelliteProduct | null;
        best_qualified: SatelliteProduct | null;
        provider_status: { provider: string; status: string; auth_state?: string } | null;
        note: string;
      };
    }>(`/fields/${fieldId}/satellite/summary`),
  discover: (fieldId: string) => request<{ ok: true; total_products: number }>(`/fields/${fieldId}/satellite/discover`, { method: "POST" }),
  /** Live STAC search with user-chosen date range + collection/cloud filters; persists new products. */
  search: (fieldId: string, body: { from: string; to: string; collections?: string[]; max_cloud?: number; limit?: number }) =>
    request<{
      ok: true;
      searched: { from: string; to: string; collections: string[]; max_cloud: number | null };
      added: number;
      by_collection: Record<string, number>;
      total: number;
    }>(`/fields/${fieldId}/satellite/search`, { method: "POST", body }),
  product: (fieldId: string, pid: string) => request<{ product: SatelliteProduct }>(`/fields/${fieldId}/satellite/products/${pid}`),
  addEvidence: (fieldId: string, pid: string) =>
    request<{ ok: true; already_added: boolean; evidence_id: string }>(`/fields/${fieldId}/satellite/products/${pid}/evidence`, {
      method: "POST",
      body: {},
    }),
  timeseries: (fieldId: string) =>
    request<{
      points: { date: string; cloud_cover: number; resolution_m: number | null; satellite: string; collection: string; product_id: string }[];
      insufficient: boolean;
      note: string;
      indices_note: string;
    }>(`/fields/${fieldId}/satellite/timeseries`),
  indices: (fieldId: string) =>
    request<{ indices: unknown[]; status: string; reason: string; products_available: number }>(`/fields/${fieldId}/satellite/indices`),
};

// ---------------------------------------------------------------------------
// Sensors / hardware
// ---------------------------------------------------------------------------
export const hardwareApi = {
  devices: (fieldId: string) => request<{ devices: DeviceRecord[] }>(`/fields/${fieldId}/devices`),
  registerDevice: (fieldId: string, body: { name: string; device_id?: string | null; kind?: string; firmware_version?: string | null; metadata?: unknown }) =>
    request<{ device: DeviceRecord }>(`/fields/${fieldId}/devices`, { method: "POST", body }),
  observations: (fieldId: string, type?: string) =>
    request<{ observations: ObservationRow[] }>(`/fields/${fieldId}/observations${type ? `?type=${encodeURIComponent(type)}` : ""}`),
};

// ---------------------------------------------------------------------------
// Farmer input
// ---------------------------------------------------------------------------
export const farmerApi = {
  list: (fieldId: string) => request<{ observations: FarmerObservation[] }>(`/fields/${fieldId}/farmer-observations`),
  add: (fieldId: string, body: { text: string; tags?: string[] }) =>
    request<{ observation: FarmerObservation }>(`/fields/${fieldId}/farmer-observations`, { method: "POST", body }),
  verify: (fieldId: string, obsId: string, verified: boolean) =>
    request<{ ok: true }>(`/fields/${fieldId}/farmer-observations/${obsId}`, { method: "PATCH", body: { verified } }),
};

// ---------------------------------------------------------------------------
// Simulations
// ---------------------------------------------------------------------------
export const simApi = {
  list: (fieldId: string) => request<{ simulations: SimulationRecord[] }>(`/fields/${fieldId}/simulations`),
  create: (fieldId: string, body: { name: string; scenario: string; inputs?: { rainfall_mm: number; irrigation_mm: number; crop_factor_kc: number; days: number; et0_source?: "uniform" | "field_climate" } }) =>
    request<{ simulation: SimulationRecord }>(`/fields/${fieldId}/simulations`, { method: "POST", body }),
  run: (simId: string) => request<{ run: { id: string; output: Record<string, unknown>; ran_at: string }; runs: { id: string; output: Record<string, unknown>; ran_at: string }[] }>(
    `/simulations/${simId}/run`,
    { method: "POST" },
  ),
  runs: (simId: string) => request<{ runs: { id: string; output: Record<string, unknown>; ran_at: string }[] }>(`/simulations/${simId}/runs`),
};

// ---------------------------------------------------------------------------
// Assistant
// ---------------------------------------------------------------------------
export const assistantApi = {
  sessions: (fieldId?: string) =>
    request<{ sessions: AssistantSession[] }>(`/assistant/sessions${fieldId ? `?field_id=${fieldId}` : ""}`),
  createSession: (body: { field_id?: string | null; title?: string }) =>
    request<{ session: AssistantSession }>(`/assistant/sessions`, { method: "POST", body }),
  getSession: (id: string) => request<{ session: AssistantSession; messages: AssistantMessage[] }>(`/assistant/sessions/${id}`),
  send: (id: string, content: string) =>
    request<{ message: AssistantMessage; answer: AssistantAnswer }>(`/assistant/sessions/${id}/messages`, { method: "POST", body: { content } }),
};

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------
export const systemApi = {
  status: () => request<Record<string, unknown>>("/system/status"),
  jobs: (fieldId?: string) => request<{ jobs: JobRecord[] }>(`/jobs${fieldId ? `?field_id=${fieldId}` : ""}`),
  events: (fieldId?: string) => request<{ events: SystemEvent[] }>(`/events${fieldId ? `?field_id=${fieldId}` : ""}`),
  providers: () => request<{ providers: ProviderMeta[] }>("/providers"),
  checkProviders: () => request<{ providers: ProviderMeta[] }>("/providers/check", { method: "POST" }),
};

/**
 * Live event stream using fetch streaming (EventSource cannot send the auth
 * header). Events are filtered server-side to the user's fields.
 */
export function streamEvents(
  onEvent: (ev: SystemEvent) => void,
  onClose: () => void,
  fieldId?: string,
): () => void {
  let cancelled = false;
  let controller: AbortController | null = null;

  const run = async () => {
    while (!cancelled) {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 120_000);
      try {
        const token = getToken();
        const url = apiUrl(`/events/stream${fieldId ? `?field_id=${fieldId}` : ""}`);
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok || !res.body) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!line) continue;
            try {
              onEvent(JSON.parse(line.slice(5).trim()) as SystemEvent);
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      } catch {
        /* stream interrupted — reconnect */
      } finally {
        clearTimeout(timeout);
      }
      if (!cancelled) await new Promise((r) => setTimeout(r, 4000));
    }
    onClose();
  };

  void run();
  return () => {
    cancelled = true;
    controller?.abort();
  };
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type ToastKind = "info" | "warn" | "error";
export function toast(message: string, kind: ToastKind = "info"): void {
  const stack = document.querySelector("#toast-stack");
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  if (stack) {
    stack.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }
}