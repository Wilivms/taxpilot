import { runCopilot } from "./copilotCore.ts";
import { COUNTRY_NAMES } from "../../agent/app/agent/src/taxEngine.ts";

const hits = new Map<string, number[]>();
const selfUrl = (req: any) => (process.env.PUBLIC_URL || `https://${req.headers["x-forwarded-host"] ?? req.headers.host}`).replace(/\/$/, "");

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0] || "anon";
  const now = Date.now(), h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (h.length >= 4) { res.status(429).json({ error: "Too many requests, wait a minute." }); return; }
  hits.set(ip, [...h, now]);
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
  const question = String(b.question ?? "").trim().slice(0, 1200);
  const uid = String(b.uid ?? "");
  const countries = (Array.isArray(b.countries) ? b.countries : []).map(String).filter((c: string) => c in COUNTRY_NAMES).slice(0, 6);
  const wallets = (Array.isArray(b.wallets) ? b.wallets : []).map(String).filter((w: string) => /^0x[a-fA-F0-9]{40}$/.test(w)).slice(0, 3);
  if (!question) { res.status(400).json({ error: "Ask a question." }); return; }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(uid)) { res.status(400).json({ error: "Missing user id." }); return; }
  if (!countries.length) countries.push("FR");
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = (ev: Record<string, unknown>) => { try { res.write(JSON.stringify(ev) + "\n"); } catch { /* client gone */ } };
  try {
    await runCopilot({ question, countries, year: Number(b.year) || 2026, wallets, uid, lang: b.lang === "fr" || b.lang === "en" ? b.lang : undefined }, { selfUrl: selfUrl(req), guardToken: process.env.GUARD_TOKEN, mcpToken: process.env.MCP_TOKEN }, emit);
  } catch (e) {
    emit({ type: "error", error: (e as Error).message });
  }
  res.end();
}
