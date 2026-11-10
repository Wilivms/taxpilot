/**
 * TaxPilot work hook: request → deterministic report → LLM plain-language summary.
 *
 * Accepted prompts:
 *   {"country":"FR","year":2026,"wallets":["0x..."]}
 *   "FR 2026 0xabc..., 0xdef..."        (free text)
 *   "demo DE"                           (built-in demo portfolio)
 */
import { compareResidencies, computeTax, DEMO, normalizeCountry, SUPPORTED, type ResidencyComparison, type TaxInput, type TaxReport } from "./taxEngine.js";
import { walletInput } from "./walletData.js";
import { buildForms, type FormPack } from "./forms.js";
import { strategies, type Strategy } from "./strategies.js";

export interface TaxRequest { country: string; countries: string[]; year: number; wallets: string[]; demo: boolean; lang: "fr" | "en"; platforms?: string[]; whatIf?: { costPerUnitEur: number; acquiredOn: string; label?: string } }

export function parseRequest(prompt: string): TaxRequest {
  let j: Record<string, unknown> = {};
  try { j = JSON.parse(prompt); } catch { /* free text */ }
  // ERC-8183 delivery wraps the buyer's task (possibly several JSON layers deep): dig for the request object.
  const dig = (x: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 6 || x == null) return null;
    if (typeof x === "string") {
      const i = x.indexOf("{");
      if (i < 0) return null;
      for (let k = x.lastIndexOf("}"); k > i; k = x.lastIndexOf("}", k - 1)) {
        const chunk = x.slice(i, k + 1);
        // the ERC-8183 description store turns JSON arrays [..] into (..): repair before parsing
        const repaired = chunk.replace(/:\s*\(/g, ":[").replace(/\)(?=\s*[,}])/g, "]");
        for (const c of [chunk, repaired]) { try { return dig(JSON.parse(c), depth + 1); } catch { /* next */ } }
      }
      return null;
    }
    if (typeof x === "object") {
      const o = x as Record<string, unknown>;
      if ("wallets" in o || "countries" in o || "country" in o) return o;
      for (const v of Object.values(o)) { const r = dig(v, depth + 1); if (r) return r; }
    }
    return null;
  };
  if (!("wallets" in j || "countries" in j || "country" in j)) { const found = dig(prompt); if (found) j = found; }
  const text = typeof j === "object" && j ? prompt : String(prompt);
  const wallets = (Array.isArray(j.wallets) ? (j.wallets as string[]) : text.match(/0x[a-fA-F0-9]{40}/g) ?? []).map(String);
  const found = [...text.replace(/0x[a-fA-F0-9]{40}/g, " ").matchAll(/\b(FR|DE|UK|GB|AE|SG|HK|MY|CH|GE|PT|IT|BE|AT|IE|ES|NL|CY|PL|US|CA|AU|JP|IN|KR|France|Germany|Allemagne|Deutschland|United Kingdom|Royaume-Uni)\b/g)].map((m) => normalizeCountry(m[1]));
  const listed = Array.isArray(j.countries) ? (j.countries as string[]).map(normalizeCountry) : [];
  const countries = [...new Set(listed.length ? listed : found)];
  const country = normalizeCountry(String(j.country ?? countries[0] ?? "FR"));
  if (!countries.includes(country)) countries.unshift(country);
  const year = Number(j.year ?? text.match(/\b20\d\d\b/)?.[0] ?? new Date().getFullYear());
  const demo = j.demo === true || /\bd[ée]mo\b/i.test(text) || wallets.length === 0;
  const lang = country === "FR" || /[àéèêç]|impôt|impot/i.test(text) ? "fr" : "en";
  const wi = j.whatIf as Record<string, unknown> | undefined;
  const whatIf = wi && Number(wi.costPerUnitEur) >= 0 && typeof wi.acquiredOn === "string" ? { costPerUnitEur: Number(wi.costPerUnitEur), acquiredOn: String(wi.acquiredOn), label: wi.label ? String(wi.label).slice(0, 80) : undefined } : undefined;
  const platforms = Array.isArray(j.platforms) ? (j.platforms as unknown[]).map((x) => String(x).slice(0, 40)).slice(0, 20) : undefined;
  return { country, countries, year, wallets, demo, lang, whatIf, platforms };
}

export async function buildReport(req: TaxRequest): Promise<{ report: TaxReport; comparison: ResidencyComparison | null; warnings: string[]; forms: FormPack; strategies: Strategy[] }> {
  const warnings: string[] = [];
  let input: TaxInput | null = null;
  if (!req.demo) {
    try {
      const w = await walletInput(req.country, req.year, req.wallets, req.whatIf);
      const ex = w.unpriced.find((u) => u.startsWith("__excess:"));
      if (ex) warnings.push(`≈€${Number(ex.split(":")[1]).toLocaleString("en-US")} of outflows came from holdings older than 365 days (unknown cost basis): excluded, declare them with your own purchase records.`);
      w.unpriced = w.unpriced.filter((u) => !u.startsWith("__excess:"));
      if (w.unpriced.length) warnings.push(`${w.unpriced.length} token(s) without price ignored: ${w.unpriced.slice(0, 8).join(", ")}${w.unpriced.length > 8 ? "…" : ""}`);
      if (!w.input.events.length) warnings.push("No priced transfer found for these wallets.");
      input = w.input;
    } catch (e) {
      warnings.push(`Live wallet analysis failed (${(e as Error).message}); showing the sample portfolio instead.`);
    }
  }
  input ??= { ...DEMO, country: req.country, year: req.year || DEMO.year };
  const report = computeTax({ ...input, country: req.country });
  const comparison = req.countries.length > 1 ? compareResidencies(input, req.countries) : null;
  return { report, comparison, warnings, forms: buildForms(report, req.platforms ?? []), strategies: strategies(report, input) };
}

export function renderComparison(c: ResidencyComparison): string {
  return [
    "## Residency comparison (nomads / several passports)",
    ...c.ranking.map((r, i) => `${i + 1}. ${r.countryName}${r.verified ? "" : " (UNVERIFIED)"}: ${r.taxDue.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${r.currency === "GBP" ? "£" : "€"} (≈ ${r.taxDueEur} €)${r.bestTip ? ` · best move: ${r.bestTip}` : ""}`),
    "",
    ...c.notes.map((n) => `- ${n}`),
  ].join("\n");
}

const money = (n: number, c: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${c === "GBP" ? "£" : "€"}`;

/** Deterministic markdown (also the fallback if the LLM is unavailable). */
export function renderMarkdown(r: TaxReport, warnings: string[]): string {
  const c = r.currency;
  const lines = [
    `# TaxPilot — ${r.countryName} ${r.taxYear}${r.verified ? "" : " (UNVERIFIED)"}`,
    `Rules: ${r.rulesVersion} · Source: ${r.source ?? "n/a"}`,
    "",
    `**Tax due: ${money(r.totals.taxDue, c)}** · net gain ${money(r.totals.netGain, c)} · exempt ${money(r.totals.exempt, c)} · taxable base ${money(r.totals.taxableBase, c)}`,
    "",
    "## Taxable events",
    ...r.taxableEvents.map((e) => `- ${e.date} ${e.asset}: proceeds ${money(e.proceeds, c)}, gain ${money(e.gain, c)} (${e.note})`),
    "",
    "## Legal optimisations",
    ...(r.tips.length ? r.tips.map((t) => `- **${t.title}** (save ~${money(t.saving, c)}): ${t.detail}`) : ["- none detected"]),
    "",
    "## Rules applied",
    ...r.rulesApplied.map((x) => `- ${x}`),
    "",
    "## Filing obligations",
    ...r.obligations.map((x) => `- ${x}`),
    ...(warnings.length ? ["", "## Warnings", ...warnings.map((w) => `- ${w}`)] : []),
    "",
    `_${r.disclaimer}_`,
  ];
  return lines.join("\n");
}

export function summaryPrompt(req: TaxRequest, r: TaxReport, c?: ResidencyComparison | null): string {
  const lang = req.lang === "fr" ? "French" : "English";
  return [
    `Write a short, friendly summary in ${lang} (max 120 words) of this crypto tax report for ${r.countryName}.`,
    "Use ONLY the numbers in the JSON. Never compute or invent a tax figure, rate or rule.",
    "Start with the tax due, then the single best optimisation and its saving.",
    r.verified ? "" : `This country is NOT in the verified rule set (${SUPPORTED.join(", ")}): say clearly the result is an unverified estimate and that support for this country is coming.`,
    c ? "The user compared several tax residences: name the cheapest verified one and remind that residence, not passport, decides." : "",
    "JSON:",
    JSON.stringify(c ? { report: r, comparison: { ranking: c.ranking, notes: c.notes } } : r),
  ].join("\n");
}

/** Fallback summary written by code (used when the LLM output is unusable). */
export function deterministicSummary(r: TaxReport, c: ResidencyComparison | null): string {
  const cur = r.currency === "GBP" ? "£" : "€";
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
  const best = [...r.tips].sort((a, b) => b.saving - a.saving)[0];
  const parts = [`**${r.countryName} ${r.taxYear}: tax due ${n(r.totals.taxDue)} ${cur}** on ${n(r.totals.netGain)} ${cur} of net gains.`];
  if (best) parts.push(`Best legal move: ${best.title} (≈ ${n(best.saving)} ${cur} saved).`);
  if (c?.cheapest) { const top = c.ranking.find((x) => x.country === c.cheapest)!; parts.push(`Cheapest verified residence among those compared: ${top.countryName} (${n(top.taxDue)} ${top.currency === "GBP" ? "£" : "€"}). Residence, not passport, decides.`); }
  return parts.join(" ");
}

export function renderForms(f: FormPack, st: Strategy[]): string {
  const cur = f.currency === "GBP" ? "£" : f.currency === "EUR" ? "€" : f.currency;
  const out: string[] = ["## Tax forms, filled"];
  for (const form of f.forms) {
    out.push(`### ${form.title}`);
    for (const x of form.fields ?? []) out.push(`- **${x.code}** ${x.label}: ${x.value}`);
    if (form.table && form.table.rows.length) {
      out.push("", `| ${form.table.columns.join(" | ")} |`, `| ${form.table.columns.map(() => "---").join(" | ")} |`);
      for (const row of form.table.rows.slice(0, 40)) out.push(`| ${row.join(" | ")} |`);
      if (form.table.rows.length > 40) out.push(`| … ${form.table.rows.length - 40} more rows in the CSV | |`);
    }
    for (const n of form.notes ?? []) out.push(`> ${n}`);
    out.push("");
  }
  if (f.deadline) out.push(`Deadline: ${f.deadline}`, "");
  out.push("## Legal optimisation strategies (computed on your numbers)");
  if (!st.length) out.push("- No strategy applies to this portfolio.");
  for (const x of st) {
    out.push(`### ${x.title} — save ≈ ${x.saving.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${cur}`, x.why, ...x.steps.map((s) => `1. ${s}`));
    if (x.caveat) out.push(`> ⚠ ${x.caveat}`);
    out.push(`_Source: ${x.source}_`, "");
  }
  out.push("## Disposal ledger (CSV)", "```csv", f.csv, "```");
  return out.join("\n");
}
