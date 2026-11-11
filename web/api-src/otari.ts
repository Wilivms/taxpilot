/**
 * Minimal Otari client (OpenAI-compatible gateway by Mozilla.ai).
 *
 * Every model call in TaxPilot goes through this file. It returns the answer
 * AND the evidence Otari attaches to it (model actually served, provider,
 * fallback, attempt count, cost, gateway-run tool calls, guardrail verdicts,
 * end-user budget), so the UI can prove each Otari feature live.
 */

export const OTARI_BASE = (process.env.OTARI_BASE_URL || "https://eu.api.otari.ai/api/v1").replace(/\/$/, "");
const KEY = () => {
  const k = process.env.OTARI_API_KEY;
  if (!k) throw new OtariError(500, "otari_not_configured", "OTARI_API_KEY is not set on the server.");
  return k;
};

export class OtariError extends Error {
  constructor(public status: number, public code: string, message: string, public endUser?: string) { super(message); }
}

export interface ToolCall {
  id: string; type: "web_search" | "web_fetch" | "code_execution" | "mcp"; status: string;
  query?: string; url?: string; sources?: { url: string; title?: string }[];
  code?: string; stdout?: string; stderr?: string; exit_code?: number;
  server?: string; name?: string; output?: string; error?: unknown;
}

export interface CallEvidence {
  role: string;
  requested: string; // model or routing policy name we asked for
  model: string; // model Otari actually served
  provider: string;
  fallback: boolean;
  attempts: number;
  router?: string;
  costUsd: number;
  ms: number;
  tokens: { in: number; out: number };
  tools: ToolCall[];
  guardrails?: unknown;
  endUserBudget?: string;
  requestId?: string;
}

export interface ChatResult { text: string; evidence: CallEvidence; raw: any }

export interface ChatOpts {
  role: string;
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  user?: string; // end user id -> per-user budget (service key)
  endUserBudget?: string; // Otari-End-User-Budget header (budget id) for a new end user
  maxTokens?: number;
  tools?: Record<string, unknown>[];
  mcpServers?: Record<string, unknown>[];
  mcpServerIds?: string[]; // MCP servers stored in the Otari workspace
  guardrails?: Record<string, unknown>[];
  responseFormat?: Record<string, unknown>;
  temperature?: number;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

const num = (v: string | null | undefined, d = 0) => (v == null || v === "" || isNaN(Number(v)) ? d : Number(v));

async function readError(r: Response): Promise<OtariError> {
  let body: any = {};
  try { body = await r.json(); } catch { /* not json */ }
  const code = String(body.code ?? r.headers.get("otari-error-code") ?? `http_${r.status}`);
  const detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail ?? body).slice(0, 300);
  return new OtariError(r.status, code, detail, body.end_user);
}

export async function chat(o: ChatOpts): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    max_tokens: o.maxTokens ?? 600,
    temperature: o.temperature ?? 0.2,
  };
  if (o.user) body.user = o.user;
  if (o.tools?.length) body.tools = o.tools;
  if (o.mcpServers?.length) body.mcp_servers = o.mcpServers;
  if (o.mcpServerIds?.length) body.mcp_server_ids = o.mcpServerIds;
  if (o.guardrails?.length) body.guardrails = o.guardrails;
  if (o.responseFormat) body.response_format = o.responseFormat;
  if (o.tools?.length || o.mcpServers?.length || o.mcpServerIds?.length) body.max_tool_iterations = 6;

  const headers: Record<string, string> = { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json", ...(o.extraHeaders ?? {}) };
  if (o.endUserBudget) headers["Otari-End-User-Budget"] = o.endUserBudget;

  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 50_000);
  let r: Response;
  try {
    r = await fetch(`${OTARI_BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new OtariError(504, "timeout", `${o.role}: Otari call timed out or failed (${(e as Error).message})`);
  } finally { clearTimeout(timer); }
  if (!r.ok) throw await readError(r);
  const raw = await r.json();
  const h = r.headers;
  const usage = raw.usage ?? {};
  let guardrails: unknown;
  const gh = h.get("otari-guardrails");
  if (gh) { try { guardrails = JSON.parse(gh); } catch { guardrails = gh; } }
  const evidence: CallEvidence = {
    role: o.role,
    requested: o.model,
    model: h.get("otari-model") ?? raw.model ?? o.model,
    provider: h.get("otari-provider") ?? "?",
    fallback: h.get("otari-fallback") === "true",
    attempts: num(h.get("otari-attempt-count"), 1),
    router: h.get("otari-router") ?? undefined,
    costUsd: num(usage.cost_usd ?? h.get("otari-cost-usd"), 0),
    ms: Date.now() - t0,
    tokens: { in: num(usage.prompt_tokens), out: num(usage.completion_tokens) },
    tools: (raw.otari_tool_calls ?? []) as ToolCall[],
    guardrails,
    endUserBudget: h.get("otari-end-user-budget") ?? undefined,
    requestId: h.get("otari-request-id") ?? undefined,
  };
  const text = String(raw.choices?.[0]?.message?.content ?? "").trim();
  return { text, evidence, raw };
}

/** Runs code in Otari's sandbox with no model in the loop (POST /code/execute). */
export async function execute(code: string, user?: string): Promise<{ stdout: string; stderr: string; returnCode: number; ms: number; costUsd: number }> {
  const t0 = Date.now();
  const r = await fetch(`${OTARI_BASE}/code/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ code, ...(user ? { user } : {}), timeout_seconds: 30 }),
  });
  if (!r.ok) throw await readError(r);
  const j = await r.json();
  return { stdout: String(j.stdout ?? ""), stderr: String(j.stderr ?? ""), returnCode: Number(j.return_code ?? -1), ms: Date.now() - t0, costUsd: num(r.headers.get("otari-cost-usd"), 0) };
}

export interface EndUserStatus { externalId: string; spend: number; limit: number | null; requests: number; requestLimit: number | null; blocked: boolean; budgetName?: string; resetsAt?: string }

/** Per-user budget status for one end user of the service key. */
export async function endUser(externalId: string): Promise<EndUserStatus | null> {
  const hdr = { Authorization: `Bearer ${KEY()}` };
  const [u, b] = await Promise.all([
    fetch(`${OTARI_BASE}/end-users?external_id=${encodeURIComponent(externalId)}`, { headers: hdr }),
    fetch(`${OTARI_BASE}/end-user-budgets`, { headers: hdr }),
  ]);
  if (!u.ok) throw await readError(u);
  const list = await u.json();
  const eu = (Array.isArray(list) ? list : list.data ?? [])[0];
  const budgets = b.ok ? await b.json() : [];
  const bl = (Array.isArray(budgets) ? budgets : budgets.data ?? []) as any[];
  if (!eu) {
    const def = bl.find((x) => x.is_default);
    return { externalId, spend: 0, limit: def?.max_budget ?? null, requests: 0, requestLimit: def?.request_limit ?? null, blocked: false, budgetName: def?.name };
  }
  const bud = bl.find((x) => x.budget_id === eu.budget_id);
  return {
    externalId, spend: num(eu.spend), limit: bud?.max_budget ?? null, requests: num(eu.current_requests),
    requestLimit: bud?.request_limit ?? null, blocked: !!eu.blocked, budgetName: bud?.name, resetsAt: eu.next_budget_reset_at ?? undefined,
  };
}

/** Pull the first JSON object out of a model answer (models sometimes wrap it in prose or fences). */
export function parseJson<T = any>(text: string): T | null {
  const s = text.replace(/```(?:json)?/gi, "");
  const i = s.indexOf("{");
  if (i < 0) return null;
  for (let k = s.lastIndexOf("}"); k > i; k = s.lastIndexOf("}", k - 1)) {
    try { return JSON.parse(s.slice(i, k + 1)) as T; } catch { /* shrink */ }
  }
  return null;
}
