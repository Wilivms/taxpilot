import { buildReport, parseRequest } from "../../agent/app/agent/src/taxWork.ts";
import { COUNTRY_NAMES } from "../../agent/app/agent/src/taxEngine.ts";

const hits = new Map<string, number[]>();
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  const ip = String(req.headers["x-forwarded-for"] ?? "").split(",")[0] || "anon";
  const now = Date.now(), h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (h.length >= 6) { res.status(429).json({ error: "Too many requests, wait a minute." }); return; }
  hits.set(ip, [...h, now]);
  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const wallets = (Array.isArray(b.wallets) ? b.wallets : []).map(String).filter((w: string) => /^0x[a-fA-F0-9]{40}$/.test(w)).slice(0, 3);
    const countries = (Array.isArray(b.countries) ? b.countries : []).map(String).filter((c: string) => c in COUNTRY_NAMES).slice(0, 8);
    if (!wallets.length) { res.status(400).json({ error: "Add at least one valid BSC wallet (0x…)." }); return; }
    if (!countries.length) { res.status(400).json({ error: "Pick at least one country." }); return; }
    const year = Number(b.year) || 2026;
    const platforms = (Array.isArray(b.platforms) ? b.platforms : []).map(String).slice(0, 10);
    const ob = b.olderBasis && Number(b.olderBasis.costPerUnitEur) >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(b.olderBasis.acquiredOn ?? "")) ? { costPerUnitEur: Number(b.olderBasis.costPerUnitEur), acquiredOn: String(b.olderBasis.acquiredOn), label: "cost basis declared by the user" } : undefined;
    const req2 = parseRequest(JSON.stringify({ countries, year, wallets, platforms, ...(ob ? { whatIf: ob } : {}) }));
    req2.demo = false;
    const out = await buildReport(req2);
    if (out.warnings.some((w) => w.startsWith("Live wallet analysis failed"))) { res.status(502).json({ error: out.warnings.join(" ") }); return; }
    if (out.comparison) (out.comparison as { reports?: unknown }).reports = undefined;
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
}
