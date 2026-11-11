/**
 * TaxPilot — decision helpers built on the deterministic engine (no AI numbers).
 *  - sellToday: extra tax if you sold 25/50/75/100 % of current holdings today, per country
 *  - taxFreeDates: when each lot becomes tax-free (or cheaper) under holding-period rules
 *  - headline: the biggest legal saving found (best strategy or best residence)
 */
import { computeTax, GENERIC, RULES, type TaxEvent, type TaxInput, type TaxReport } from "./taxEngine.js";
import { latent, type Strategy } from "./strategies.js";

const r2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const toEur = (r: TaxReport) => (r.currency === "GBP" ? r.totals.taxDue / RULES.GB.defaultEurToGbp : r.totals.taxDue);

export interface SellSim { pct: number; valueEur: number; byCountry: Record<string, number> }

/** Extra tax (EUR) caused by selling `pct` of every current holding to fiat today. */
export function sellToday(input: TaxInput, countries: string[]): SellSim[] {
  const d = today();
  const year = Number(d.slice(0, 4));
  const lots = latent(input);
  const holdings: Record<string, number> = {};
  for (const l of lots) holdings[l.asset] = (holdings[l.asset] ?? 0) + l.qty;
  const priced = Object.entries(holdings).filter(([a, q]) => q > 0 && (input.currentPrices[a] ?? 0) > 0);
  if (!priced.length) return [];
  const prices = { ...input.prices, [d]: { ...(input.prices[d] ?? {}), ...input.currentPrices } };
  const base: Record<string, number> = {};
  for (const c of countries) base[c] = toEur(computeTax({ ...input, prices, year, country: c }));
  return [25, 50, 75, 100].map((pct) => {
    const sells: TaxEvent[] = priced.map(([a, q]) => ({ date: d, type: "sell", asset: a, qty: q * pct / 100, eur: q * pct / 100 * input.currentPrices[a] }));
    const byCountry: Record<string, number> = {};
    for (const c of countries) byCountry[c] = r2(Math.max(0, toEur(computeTax({ ...input, prices, year, country: c, events: [...input.events, ...sells] })) - base[c]));
    return { pct, valueEur: r2(sells.reduce((s, e) => s + e.eur, 0)), byCountry };
  });
}

export interface TaxFreeDate { country: string; asset: string; qty: number; acquired: string; date: string; gainEur: number; label: string }

/** Lots in latent gain that become tax-free (or move to a lower rate) on a future date. */
export function taxFreeDates(input: TaxInput, countries: string[]): TaxFreeDate[] {
  const now = today();
  const out: TaxFreeDate[] = [];
  for (const c of countries) {
    const g = GENERIC[c];
    const lt = c === "DE" ? RULES.DE.holdingDaysTaxFree : g?.ltDays;
    if (lt === undefined) continue;
    const exempt = c === "DE" || (g?.ltRate ?? 1) === 0;
    for (const l of latent(input)) {
      const gain = l.value - l.cost;
      const date = new Date(Date.parse(l.date) + (lt + 1) * 864e5).toISOString().slice(0, 10);
      if (gain < 1 || date <= now) continue;
      out.push({ country: c, asset: l.asset, qty: r2(l.qty), acquired: l.date, date, gainEur: r2(gain), label: exempt ? `${l.asset} becomes tax-free in ${c}` : `${l.asset} moves to the ${Math.round((g!.ltRate ?? 0) * 100)}% long-term rate in ${c}` });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 40);
}

export interface Headline { kind: "strategy" | "residence" | "none"; text: string; savingEur: number }

export function headline(report: TaxReport, strats: Strategy[], ranking?: { country: string; countryName: string; taxDueEur: number; verified: boolean }[]): Headline {
  const best = strats[0];
  const mine = ranking?.find((x) => x.country === report.country);
  const cheapest = ranking?.find((x) => x.verified);
  const resSave = mine && cheapest && cheapest.country !== report.country ? r2(mine.taxDueEur - cheapest.taxDueEur) : 0;
  const stratSave = best ? (report.currency === "GBP" ? r2(best.saving / RULES.GB.defaultEurToGbp) : best.saving) : 0;
  if (resSave <= 0 && stratSave <= 0) return { kind: "none", text: "Nothing to optimise: your bill is already at its legal minimum.", savingEur: 0 };
  if (resSave > stratSave) return { kind: "residence", text: `Being tax resident in ${cheapest!.countryName} instead of ${mine!.countryName} would cost €${resSave.toLocaleString("en-US")} less on the same trades.`, savingEur: resSave };
  return { kind: "strategy", text: `${best.title}: could legally save about €${stratSave.toLocaleString("en-US")}.`, savingEur: stratSave };
}
