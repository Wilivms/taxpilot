/**
 * TaxPilot MCP server (streamable HTTP, stateless JSON responses).
 *
 * Exposes the deterministic tax engine as MCP tools. Otari connects to it
 * (`mcp_servers` on a chat completion), so an open-weight model can pull the
 * exact report, rules and ledger instead of guessing numbers.
 */
import { buildReport, parseRequest } from "../../agent/app/agent/src/taxWork.ts";
import { COUNTRY_NAMES, SUPPORTED } from "../../agent/app/agent/src/taxEngine.ts";
import { ruleSheet } from "./rules.ts";

export const PROTOCOL = "2025-06-18";

const countryProp = { type: "string", description: `ISO-2 country code, one of ${SUPPORTED.join(", ")}` };
const walletsProp = { type: "array", items: { type: "string" }, description: "Public BSC wallet addresses (0x...). Omit to use the built-in demo portfolio." };
const yearProp = { type: "integer", description: "Tax year, e.g. 2026" };

export const TOOLS = [
  {
    name: "get_tax_report",
    description: "Compute the deterministic crypto tax report for one country: totals (tax due, net gain, exempt, taxable base), every disposal line, rules applied and legal optimisation tips. All numbers come from code, never from a model.",
    inputSchema: { type: "object", properties: { country: countryProp, year: yearProp, wallets: walletsProp }, required: ["country"] },
  },
  {
    name: "get_disposal_ledger",
    description: "Return the disposal ledger as CSV (date, asset, qty, proceeds, cost, gain) plus the engine's totals, so the numbers can be independently recomputed.",
    inputSchema: { type: "object", properties: { country: countryProp, year: yearProp, wallets: walletsProp }, required: ["country"] },
  },
  {
    name: "get_tax_rules",
    description: "Return the versioned tax rule set the engine applies for a country (rates, allowances, holding periods) with the engine's source, so it can be checked against current law.",
    inputSchema: { type: "object", properties: { country: countryProp }, required: ["country"] },
  },
  {
    name: "compare_residencies",
    description: "Compare the tax due on the same portfolio across several candidate tax residences (nomads, several passports).",
    inputSchema: { type: "object", properties: { countries: { type: "array", items: countryProp }, year: yearProp, wallets: walletsProp }, required: ["countries"] },
  },
];

const clean = (a: any) => ({
  country: String(a?.country ?? "FR").toUpperCase(),
  year: Number(a?.year) || 2026,
  wallets: (Array.isArray(a?.wallets) ? a.wallets : []).map(String).filter((w: string) => /^0x[a-fA-F0-9]{40}$/.test(w)).slice(0, 3),
});

async function report(a: any, countries?: string[]) {
  const c = clean(a);
  const req = parseRequest(JSON.stringify({ country: c.country, countries: countries ?? [c.country], year: c.year, wallets: c.wallets }));
  req.demo = c.wallets.length === 0;
  return buildReport(req);
}

export async function callTool(name: string, args: any): Promise<string> {
  if (name === "get_tax_rules") return JSON.stringify(ruleSheet(String(args?.country ?? "FR")));
  if (name === "get_tax_report") {
    const out = await report(args);
    const r = out.report;
    return JSON.stringify({
      country: r.country, countryName: r.countryName, taxYear: r.taxYear, currency: r.currency, rulesVersion: r.rulesVersion, verified: r.verified,
      portfolio: out.warnings.length ? out.warnings : r.source, totals: r.totals,
      lines: r.lines.map((l) => ({ date: l.date, asset: l.asset, qty: l.qty, acquired: l.acquired, proceeds: l.proceeds, cost: l.cost, gain: l.gain, term: l.term })),
      rulesApplied: r.rulesApplied, tips: r.tips.map((t) => ({ title: t.title, saving: t.saving })), obligations: r.obligations,
    });
  }
  if (name === "get_disposal_ledger") {
    const out = await report(args);
    const r = out.report;
    const rows = r.lines.map((l) => [l.date, l.asset, l.qty, l.proceeds, l.cost, l.gain].join(","));
    return JSON.stringify({ country: r.country, currency: r.currency, csv: ["date,asset,qty,proceeds,cost,gain", ...rows].join("\n"), engineTotals: r.totals, rulesApplied: r.rulesApplied });
  }
  if (name === "compare_residencies") {
    const cs = (Array.isArray(args?.countries) ? args.countries : []).map((x: unknown) => String(x).toUpperCase()).filter((x: string) => x in COUNTRY_NAMES).slice(0, 8);
    if (!cs.length) throw new Error("countries must list ISO-2 codes");
    const out = await report({ ...args, country: cs[0] }, cs);
    return JSON.stringify(out.comparison ? { ranking: out.comparison.ranking, notes: out.comparison.notes } : { ranking: [{ country: cs[0], taxDue: out.report.totals.taxDue }] });
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** Handle one JSON-RPC message. Returns null for notifications (HTTP 202). */
export async function handleRpc(msg: any): Promise<any | null> {
  const id = msg?.id;
  if (id === undefined || id === null) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "taxpilot", title: "TaxPilot crypto tax engine", version: "1.0.0" },
        instructions: "Deterministic crypto tax engine. Use these tools for every number; never compute tax figures yourself.",
      });
    case "ping": return ok({});
    case "tools/list": return ok({ tools: TOOLS });
    case "tools/call": {
      const name = String(msg.params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const text = await callTool(name, msg.params?.arguments ?? {});
        return ok({ content: [{ type: "text", text }], isError: false });
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}
