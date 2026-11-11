/** Human/LLM-readable view of the rule set the deterministic engine applies, per country. */
import { COUNTRY_NAMES, GENERIC, RULES } from "../../agent/app/agent/src/taxEngine.ts";

export interface RuleClaim { id: string; claim: string; value: string }
export interface RuleSheet { country: string; name: string; version: string; claims: RuleClaim[]; notes: string[]; engineSource: string }

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function ruleSheet(code: string): RuleSheet {
  const c = code.toUpperCase() === "UK" ? "GB" : code.toUpperCase();
  if (c === "FR") {
    const R = RULES.FR;
    return { country: c, name: R.name, version: R.version, engineSource: "LFSS 2026 / CGI art. 150 VH bis", notes: [], claims: [
      { id: "rate", claim: "Flat tax (PFU) rate on crypto disposal gains by individuals", value: pct(R.flatTax) },
      { id: "split", claim: "Split between income tax and social levies", value: `${pct(R.ir)} IR + ${pct(R.social)} social levies` },
      { id: "exempt", claim: "Annual disposals below which crypto gains are exempt", value: `€${R.exemptDisposalsEur}` },
    ] };
  }
  if (c === "DE") {
    const R = RULES.DE;
    return { country: c, name: R.name, version: R.version, engineSource: "§23 EStG", notes: [], claims: [
      { id: "holding", claim: "Holding period after which private crypto disposals are tax-free", value: "more than 1 year" },
      { id: "freigrenze", claim: "Annual Freigrenze (exemption limit, cliff) for private disposal gains", value: `€${R.freigrenzeEur}` },
    ] };
  }
  if (c === "GB") {
    const R = RULES.GB;
    return { country: c, name: R.name, version: R.version, engineSource: "HMRC CGT 2026/27", notes: [], claims: [
      { id: "aea", claim: "Capital gains tax annual exempt amount", value: `£${R.annualExemptGbp}` },
      { id: "rates", claim: "CGT rates on crypto for basic / higher rate taxpayers", value: `${pct(R.basicRate)} / ${pct(R.higherRate)}` },
    ] };
  }
  const g = GENERIC[c];
  if (!g) return { country: c, name: COUNTRY_NAMES[c] ?? c, version: "unverified", engineSource: "none", notes: ["No rule set in the engine."], claims: [] };
  const claims: RuleClaim[] = [];
  if (g.bands) claims.push({ id: "bands", claim: "Tax bands on crypto capital gains for individuals", value: g.bands.map(([u, r]) => `${pct(r)}${isFinite(u) ? ` up to €${u}` : " above"}`).join(", ") });
  else if (g.rate !== undefined) claims.push({ id: "rate", claim: "Tax rate on crypto capital gains for individuals", value: pct(g.rate) });
  if (g.ltDays) claims.push({ id: "longterm", claim: `Treatment of crypto held more than ${g.ltDays} days`, value: g.ltRate ? `taxed at ${pct(g.ltRate)}` : "exempt" });
  if (g.allowanceEur) claims.push({ id: "allowance", claim: "Annual exemption", value: `€${g.allowanceEur}${g.cliff ? " (cliff)" : ""}` });
  claims.push({ id: "c2c", claim: "Are crypto-to-crypto swaps taxable", value: g.c2cTaxable ? "yes" : "no" });
  return { country: c, name: g.name, version: "2026.1", engineSource: g.source, notes: g.notes, claims };
}
