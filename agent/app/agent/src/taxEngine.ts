/**
 * TaxPilot — deterministic crypto tax engine (FR / DE / UK).
 *
 * All tax math lives HERE, in fixed code. The LLM never computes a tax figure:
 * it only rewrites this engine's JSON report in plain language.
 *
 * Rules are versioned per country (RULES). Adding a country = adding a rule set
 * + its calculator. Countries without a rule set are reported as UNVERIFIED.
 *
 * Not tax advice.
 */

export type EventType = "buy" | "sell" | "swap";

/** One wallet event, valued in EUR (base currency of the engine). */
export interface TaxEvent {
  date: string; // YYYY-MM-DD
  type: EventType;
  asset: string;
  qty: number;
  /** EUR value of the leg: cost for buy, proceeds for sell, market value for swap. */
  eur: number;
  toAsset?: string; // swap only
  toQty?: number; // swap only
  tx?: string;
}

export interface TaxInput {
  country: string; // ISO-2: FR, DE, GB (UK accepted)
  year: number;
  events: TaxEvent[];
  /** EUR price per unit, per date: { "2026-03-20": { BNB: 800, ... } }. Used for FR portfolio value. */
  prices: Record<string, Record<string, number>>;
  /** EUR price per unit today, for holdings-based tips. */
  currentPrices: Record<string, number>;
  /** Optional taxpayer parameters. */
  params?: { deIncomeTaxRate?: number; ukHigherRate?: boolean; eurToGbp?: number; frTmi?: number };
  source?: string;
}

export interface Tip {
  title: string;
  detail: string;
  saving: number; // in report currency
}

/** One disposal (or lot slice) as tax forms need it. */
export interface DisposalLine {
  date: string;
  asset: string;
  qty: number;
  acquired?: string; // acquisition date of the lot (FIFO), when known
  proceeds: number;
  cost: number;
  gain: number;
  term?: "short" | "long";
  /** France, form 2086 lines for this cession */
  fr?: { l211: string; l212: number; l213: number; l214: number; l216: number; l217: number; l218: number; l220: number; l221: number; l222: number; l223: number; l224: number };
}

export interface TaxReport {
  country: string;
  countryName: string;
  verified: boolean;
  rulesVersion: string;
  taxYear: string;
  currency: "EUR" | "GBP";
  taxableEvents: { date: string; asset: string; proceeds: number; gain: number; note: string }[];
  lines: DisposalLine[];
  totals: { proceeds: number; netGain: number; exempt: number; taxableBase: number; taxDue: number; effectiveRate: number };
  rulesApplied: string[];
  tips: Tip[];
  holdings: { asset: string; qty: number; valueEur: number }[];
  obligations: string[];
  disclaimer: string;
  source?: string;
}

export const RULES = {
  FR: {
    name: "France",
    version: "FR-2026.1 (vérifié le 10/11/2026)",
    flatTax: 0.314, // 12.8% IR + 18.6% prélèvements sociaux (LFSS 2026)
    ir: 0.128,
    social: 0.186,
    exemptDisposalsEur: 305,
  },
  DE: {
    name: "Germany",
    version: "DE-2026.1 (verified 10/11/2026)",
    holdingDaysTaxFree: 365, // tax-free when held MORE than one year
    freigrenzeEur: 1000, // §23 EStG, cliff (not an allowance)
    defaultIncomeTaxRate: 0.42,
  },
  GB: {
    name: "United Kingdom",
    version: "UK-2026/27.1 (verified 10/11/2026)",
    annualExemptGbp: 3000,
    basicRate: 0.18,
    higherRate: 0.24,
    defaultEurToGbp: 0.87,
  },
} as const;

export const SUPPORTED = ["FR", "DE", "GB", "AE", "SG", "HK", "MY", "CH", "GE", "PT", "IT", "BE", "AT", "IE", "ES", "NL", "CY", "PL", "US", "CA", "AU", "JP", "IN", "KR"] as const;
export const COUNTRY_NAMES: Record<string, string> = { FR: "France", DE: "Germany", GB: "United Kingdom", AE: "United Arab Emirates", SG: "Singapore", HK: "Hong Kong", MY: "Malaysia", CH: "Switzerland", GE: "Georgia", PT: "Portugal", IT: "Italy", BE: "Belgium", AT: "Austria", IE: "Ireland", ES: "Spain", NL: "Netherlands", CY: "Cyprus", PL: "Poland", US: "United States", CA: "Canada", AU: "Australia", JP: "Japan", IN: "India", KR: "South Korea" };

const DISCLAIMER =
  "Estimation automatique à partir des données onchain, pas un conseil fiscal. Vérifie avec un professionnel avant de déclarer.";

const r2 = (n: number) => Math.round(n * 100) / 100;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

export function normalizeCountry(c: string): string {
  const k = c.trim().toUpperCase();
  const map: Record<string, string> = {
    UK: "GB", "UNITED KINGDOM": "GB", ENGLAND: "GB", "ROYAUME-UNI": "GB", GB: "GB",
    FRANCE: "FR", FR: "FR", GERMANY: "DE", ALLEMAGNE: "DE", DEUTSCHLAND: "DE", DE: "DE",
  };
  return map[k] ?? k;
}

function sorted(events: TaxEvent[]): TaxEvent[] {
  return [...events].sort((a, b) => a.date.localeCompare(b.date));
}

function holdingsAfter(events: TaxEvent[], untilDate?: string, inclusive = true): Record<string, number> {
  const h: Record<string, number> = {};
  for (const e of sorted(events)) {
    if (untilDate && (inclusive ? e.date > untilDate : e.date >= untilDate)) break;
    if (e.type === "buy") h[e.asset] = (h[e.asset] ?? 0) + e.qty;
    else {
      h[e.asset] = (h[e.asset] ?? 0) - e.qty;
      if (e.type === "swap" && e.toAsset) h[e.toAsset] = (h[e.toAsset] ?? 0) + (e.toQty ?? 0);
    }
  }
  for (const k of Object.keys(h)) if (Math.abs(h[k]) < 1e-12) delete h[k];
  return h;
}

function holdingsList(input: TaxInput) {
  const h = holdingsAfter(input.events);
  return Object.entries(h).map(([asset, qty]) => ({ asset, qty: r2(qty), valueEur: r2(qty * (input.currentPrices[asset] ?? 0)) }));
}

// ───────────────────────────── France ─────────────────────────────
function computeFR(input: TaxInput): TaxReport {
  const R = RULES.FR;
  let pta = 0; // prix total d'acquisition net
  let gross = 0, fractions = 0; // lignes 220 et 221 du 2086
  const evs = sorted(input.events);
  const taxable: TaxReport["taxableEvents"] = [];
  const lines: DisposalLine[] = [];
  let proceedsYear = 0;
  for (const e of evs) {
    if (e.type === "buy") { pta += e.eur; gross += e.eur; continue; }
    if (e.type === "swap") continue; // crypto → crypto (stablecoins inclus) : sursis d'imposition
    // sell → fiat : cession imposable, formule globale art. 150 VH bis
    const before = holdingsAfter(evs, e.date, false);
    const px = input.prices[e.date] ?? {};
    let V = 0;
    for (const [a, q] of Object.entries(before)) V += q * (px[a] ?? 0);
    if (!(V >= e.eur)) V = e.eur; // portfolio value can never be below the sale itself
    const share = Math.max(0, Math.min(pta, pta * (e.eur / V)));
    const gain = e.eur - share;
    const l220 = gross, l221 = fractions, l223 = pta;
    pta -= share;
    fractions += share;
    if (e.date.startsWith(String(input.year))) {
      proceedsYear += e.eur;
      lines.push({ date: e.date, asset: e.asset, qty: e.qty, proceeds: r2(e.eur), cost: r2(share), gain: r2(gain),
        fr: { l211: e.date.split("-").reverse().join("/"), l212: r2(V), l213: r2(e.eur), l214: 0, l216: 0, l217: r2(e.eur), l218: r2(e.eur), l220: r2(l220), l221: r2(l221), l222: 0, l223: r2(l223), l224: r2(gain) } });
      taxable.push({ date: e.date, asset: e.asset, proceeds: r2(e.eur), gain: r2(gain), note: `PV = ${r2(e.eur)} − ${r2(pta + share)} × ${r2(e.eur)} / ${r2(V)}` });
    }
  }
  const net = taxable.reduce((s, t) => s + t.gain, 0);
  const exemptAll = proceedsYear <= R.exemptDisposalsEur;
  const base = exemptAll ? 0 : Math.max(0, net);
  const tax = base * R.flatTax;
  const tips: Tip[] = [];
  const fiatSales = taxable.length;
  if (fiatSales > 0 && tax > 0)
    tips.push({
      title: "Rester en stablecoins au lieu de repasser en euros",
      detail: `Tes ${fiatSales} ventes en euros ont déclenché l'impôt. Un échange crypto → stablecoin (USDT, USDC) n'est pas imposable en France : ne convertis en euros que ce dont tu as réellement besoin.`,
      saving: r2(tax),
    });
  if (!exemptAll && proceedsYear < 2 * R.exemptDisposalsEur)
    tips.push({ title: "Seuil de 305 € de cessions", detail: `Tes cessions totales (${r2(proceedsYear)} €) dépassent à peine 305 €. En étalant sur deux années civiles, tu restes exonéré.`, saving: r2(tax) });
  // Option barème si TMI faible
  const tmiCases = [0, 0.11];
  if (base > 0) {
    const tmi = input.params?.frTmi;
    const best = tmi !== undefined ? tmi : 0;
    const bareme = base * (best + R.social);
    if (bareme < tax)
      tips.push({ title: "Option pour le barème progressif", detail: `Si ta tranche marginale est ${tmi !== undefined ? Math.round(tmi * 100) + " %" : "0 % ou 11 %"}, l'option barème remplace les 12,8 % d'impôt par ta TMI (prélèvements sociaux de 18,6 % inchangés).`, saving: r2(tax - bareme) });
  }
  // Portefeuille global en moins-value latente ?
  const now = holdingsAfter(evs);
  let vNow = 0;
  for (const [a, q] of Object.entries(now)) vNow += q * (input.currentPrices[a] ?? 0);
  if (vNow > 0 && pta > vNow && net > 0) {
    const saving = Math.min(pta - vNow, net) * R.flatTax;
    if (saving > 0) tips.push({ title: "Réaliser une moins-value avant le 31/12", detail: `Ton portefeuille vaut ${r2(vNow)} € pour un prix d'acquisition restant de ${r2(pta)} €. Une cession avant la fin de l'année crée une moins-value imputable sur tes gains de ${input.year}.`, saving: r2(saving) });
  }
  void tmiCases;
  return {
    country: "FR", countryName: R.name, verified: true, rulesVersion: R.version,
    taxYear: String(input.year), currency: "EUR", taxableEvents: taxable, lines,
    totals: { proceeds: r2(proceedsYear), netGain: r2(net), exempt: exemptAll ? r2(Math.max(0, net)) : 0, taxableBase: r2(base), taxDue: r2(tax), effectiveRate: net > 0 ? r2(tax / net) : 0 },
    rulesApplied: [
      "Flat tax 31,4 % (12,8 % IR + 18,6 % prélèvements sociaux, LFSS 2026)",
      "Méthode globale du prix total d'acquisition (art. 150 VH bis CGI)",
      "Échanges crypto → crypto non imposables (sursis)",
      "Exonération si cessions annuelles ≤ 305 €",
      "Moins-values imputables sur les plus-values de la même année",
    ],
    tips, holdings: holdingsList(input),
    obligations: ["Formulaire 2086 (plus-values) et case 3AN/3BN de la 2042-C", "Formulaire 3916-bis pour chaque compte sur une plateforme étrangère"],
    disclaimer: DISCLAIMER, source: input.source,
  };
}

// ───────────────────────────── Germany ─────────────────────────────
interface Lot { date: string; qty: number; unit: number }

function computeDE(input: TaxInput): TaxReport {
  const R = RULES.DE;
  const rate = input.params?.deIncomeTaxRate ?? R.defaultIncomeTaxRate;
  const lots: Record<string, Lot[]> = {};
  const add = (a: string, date: string, qty: number, eur: number) => (lots[a] ??= []).push({ date, qty, unit: eur / qty });
  const taxable: TaxReport["taxableEvents"] = [];
  const shortTerm: { date: string; asset: string; gain: number; freeOn: string; days: number }[] = [];
  const deLines: DisposalLine[] = [];
  let proceedsYear = 0, exemptLong = 0;
  for (const e of sorted(input.events)) {
    if (e.type === "buy") { add(e.asset, e.date, e.qty, e.eur); continue; }
    // sell or swap = disposal (FIFO)
    let left = e.qty;
    const unitProceeds = e.eur / e.qty;
    const inYear = e.date.startsWith(String(input.year));
    let shortGain = 0, longGain = 0;
    const q = lots[e.asset] ?? [];
    while (left > 1e-12 && q.length) {
      const lot = q[0];
      const take = Math.min(lot.qty, left);
      const g = take * (unitProceeds - lot.unit);
      const held = days(lot.date, e.date);
      if (inYear) deLines.push({ date: e.date, asset: e.asset, qty: take, acquired: lot.date, proceeds: r2(take * unitProceeds), cost: r2(take * lot.unit), gain: r2(g), term: held > R.holdingDaysTaxFree ? "long" : "short" });
      if (held > R.holdingDaysTaxFree) longGain += g;
      else {
        shortGain += g;
        if (inYear) shortTerm.push({ date: e.date, asset: e.asset, gain: g, freeOn: addDays(lot.date, R.holdingDaysTaxFree + 1), days: R.holdingDaysTaxFree + 1 - held });
      }
      lot.qty -= take; left -= take;
      if (lot.qty <= 1e-12) q.shift();
    }
    if (e.type === "swap" && e.toAsset) add(e.toAsset, e.date, e.toQty ?? 0, e.eur);
    if (inYear) {
      proceedsYear += e.eur;
      exemptLong += longGain;
      taxable.push({ date: e.date, asset: e.asset, proceeds: r2(e.eur), gain: r2(shortGain + longGain), note: longGain !== 0 && shortGain === 0 ? "held > 1 year: tax-free" : shortGain !== 0 && longGain === 0 ? "held ≤ 1 year: taxable" : "mixed lots (FIFO)" });
    }
  }
  const S = shortTerm.reduce((s, t) => s + t.gain, 0);
  const underCliff = S < R.freigrenzeEur;
  const base = underCliff ? 0 : Math.max(0, S);
  const tax = base * rate;
  const tips: Tip[] = [];
  for (const t of shortTerm.filter((x) => x.gain > 0))
    tips.push({ title: `Wait ${t.days} more day(s) on ${t.asset}`, detail: `Your ${t.asset} disposal on ${t.date} was ${t.days} day(s) short of the one-year rule. Selling on or after ${t.freeOn} would have been tax-free.`, saving: r2(underCliff ? 0 : Math.min(t.gain * rate, tax)) });
  if (!underCliff && S < R.freigrenzeEur * 2)
    tips.push({ title: "€1,000 Freigrenze cliff", detail: `Short-term gains of €${r2(S)} crossed the €1,000 cliff, so ALL of it is taxed. Pushing €${r2(S - 999)} of gains into next year keeps this year at zero.`, saving: r2(tax) });
  // upcoming tax-free dates on current holdings
  const today = new Date().toISOString().slice(0, 10);
  for (const [a, q] of Object.entries(lots))
    for (const lot of q) {
      const freeOn = addDays(lot.date, R.holdingDaysTaxFree + 1);
      const unreal = lot.qty * ((input.currentPrices[a] ?? 0) - lot.unit);
      if (freeOn > today && unreal > 0)
        tips.push({ title: `Don't sell ${a} before ${freeOn}`, detail: `${r2(lot.qty)} ${a} bought on ${lot.date} carry €${r2(unreal)} of unrealised gain. Hold until ${freeOn} and it becomes tax-free.`, saving: r2(unreal * rate) });
    }
  return {
    country: "DE", countryName: R.name, verified: true, rulesVersion: R.version,
    taxYear: String(input.year), currency: "EUR", taxableEvents: taxable, lines: deLines,
    totals: { proceeds: r2(proceedsYear), netGain: r2(S + exemptLong), exempt: r2(exemptLong + (underCliff ? Math.max(0, S) : 0)), taxableBase: r2(base), taxDue: r2(tax), effectiveRate: S + exemptLong > 0 ? r2(tax / (S + exemptLong)) : 0 },
    rulesApplied: [
      "§23 EStG private disposal: tax-free after holding > 1 year",
      "Crypto-to-crypto swaps are disposals",
      "FIFO lot matching",
      "€1,000 Freigrenze on short-term gains (cliff, not an allowance)",
      `Personal income tax rate assumed: ${Math.round(rate * 100)}%`,
    ],
    tips, holdings: holdingsList(input),
    obligations: ["Anlage SO (sonstige Einkünfte) in the annual return"],
    disclaimer: DISCLAIMER, source: input.source,
  };
}

// ───────────────────────────── United Kingdom ─────────────────────────────
function computeGB(input: TaxInput): TaxReport {
  const R = RULES.GB;
  const fx = input.params?.eurToGbp ?? R.defaultEurToGbp;
  const rate = input.params?.ukHigherRate === false ? R.basicRate : R.higherRate;
  const start = `${input.year}-04-06`, end = `${input.year + 1}-04-05`;
  const pool: Record<string, { qty: number; cost: number }> = {};
  const gbLines: DisposalLine[] = [];
  const taxable: TaxReport["taxableEvents"] = [];
  let proceedsYear = 0;
  for (const e of sorted(input.events)) {
    const gbp = e.eur * fx;
    if (e.type === "buy") { const p = (pool[e.asset] ??= { qty: 0, cost: 0 }); p.qty += e.qty; p.cost += gbp; continue; }
    const p = (pool[e.asset] ??= { qty: 0, cost: 0 });
    const cost = p.qty > 0 ? p.cost * (e.qty / p.qty) : 0;
    p.qty -= e.qty; p.cost -= cost;
    if (e.type === "swap" && e.toAsset) { const t = (pool[e.toAsset] ??= { qty: 0, cost: 0 }); t.qty += e.toQty ?? 0; t.cost += gbp; }
    if (e.date >= start && e.date <= end) {
      proceedsYear += gbp;
      taxable.push({ date: e.date, asset: e.asset, proceeds: r2(gbp), gain: r2(gbp - cost), note: "Section 104 pool cost" });
      gbLines.push({ date: e.date, asset: e.asset, qty: e.qty, proceeds: r2(gbp), cost: r2(cost), gain: r2(gbp - cost) });
    }
  }
  const net = taxable.reduce((s, t) => s + t.gain, 0);
  const base = Math.max(0, net - R.annualExemptGbp);
  const tax = base * rate;
  const tips: Tip[] = [];
  if (net < R.annualExemptGbp)
    tips.push({ title: "Use your unused £3,000 allowance", detail: `You only used £${r2(Math.max(0, net))} of your £3,000 annual exempt amount. Realising up to £${r2(R.annualExemptGbp - Math.max(0, net))} more gains before 5 April (rebuy after 30 days, bed-and-breakfast rule) resets your cost basis higher for free.`, saving: r2((R.annualExemptGbp - Math.max(0, net)) * rate) });
  if (base > 0) {
    let losses = 0;
    for (const [a, p] of Object.entries(pool)) {
      const val = p.qty * (input.currentPrices[a] ?? 0) * fx;
      if (p.qty > 0 && val < p.cost) losses += p.cost - val;
    }
    if (losses > 0)
      tips.push({ title: "Harvest unrealised losses before 5 April", detail: `Your pools hold £${r2(losses)} of unrealised losses. Disposing of them offsets this year's gains (wait 30 days before rebuying).`, saving: r2(Math.min(losses, base) * rate) });
    tips.push({ title: "Transfer to your spouse before selling", detail: "Transfers between spouses/civil partners are no-gain/no-loss, and each has their own £3,000 allowance.", saving: r2(Math.min(base, R.annualExemptGbp) * rate) });
  }
  return {
    country: "GB", countryName: R.name, verified: true, rulesVersion: R.version,
    taxYear: `${input.year}/${String(input.year + 1).slice(2)} (6 Apr–5 Apr)`, currency: "GBP", taxableEvents: taxable, lines: gbLines,
    totals: { proceeds: r2(proceedsYear), netGain: r2(net), exempt: r2(Math.min(Math.max(0, net), R.annualExemptGbp)), taxableBase: r2(base), taxDue: r2(tax), effectiveRate: net > 0 ? r2(tax / net) : 0 },
    rulesApplied: [
      "Capital Gains Tax: 18% basic / 24% higher rate (since 30 Oct 2024)",
      "£3,000 annual exempt amount (2026/27)",
      "Section 104 pooling (same-day/30-day matching simplified)",
      "Crypto-to-crypto swaps are disposals",
      `EUR→GBP at ${fx} (indicative)`,
    ],
    tips, holdings: holdingsList(input),
    obligations: ["Self Assessment capital gains pages (SA108) by 31 January"],
    disclaimer: DISCLAIMER, source: input.source,
  };
}

export function computeTax(input: TaxInput): TaxReport {
  const c = normalizeCountry(input.country);
  const inp = { ...input, country: c };
  if (c === "FR") return computeFR(inp);
  if (c === "DE") return computeDE(inp);
  if (c === "GB") return computeGB(inp);
  if (GENERIC[c]) return computeGeneric(inp, c, GENERIC[c]);
  return {
    country: c, countryName: c, verified: false, rulesVersion: "none",
    taxYear: String(input.year), currency: "EUR", taxableEvents: [], lines: [],
    totals: { proceeds: 0, netGain: 0, exempt: 0, taxableBase: 0, taxDue: 0, effectiveRate: 0 },
    rulesApplied: ["Not supported yet: this country's rules are not verified. Supported: " + "FR DE GB AE SG HK MY CH GE PT IT BE AT IE ES NL CY PL US CA AU JP IN KR"],
    tips: [], holdings: holdingsList(inp), obligations: [], disclaimer: DISCLAIMER, source: input.source,
  };
}

// ───────────────────────────── Demo portfolio ─────────────────────────────
/** One realistic BSC portfolio (BNB, CAKE, USDT), valued in EUR. */
export const DEMO: Omit<TaxInput, "country"> = {
  year: 2026,
  source: "demo portfolio (BNB / CAKE / USDT on BSC)",
  events: [
    { date: "2025-02-10", type: "buy", asset: "BNB", qty: 10, eur: 5500 },
    { date: "2025-06-01", type: "buy", asset: "CAKE", qty: 2000, eur: 4000 },
    { date: "2026-01-15", type: "swap", asset: "BNB", qty: 6, eur: 4440, toAsset: "USDT", toQty: 4800 },
    { date: "2026-03-20", type: "sell", asset: "BNB", qty: 3, eur: 2400 },
    { date: "2026-05-05", type: "sell", asset: "USDT", qty: 1500, eur: 1380 },
    { date: "2026-09-01", type: "sell", asset: "CAKE", qty: 1000, eur: 3500 },
  ],
  prices: {
    "2026-01-15": { BNB: 740, CAKE: 2.4, USDT: 0.925 },
    "2026-03-20": { BNB: 800, CAKE: 2.6, USDT: 0.92 },
    "2026-05-05": { BNB: 820, CAKE: 3.0, USDT: 0.92 },
    "2026-09-01": { BNB: 860, CAKE: 3.5, USDT: 0.87 },
  },
  currentPrices: { BNB: 900, CAKE: 1.6, USDT: 0.86 },
};


// ───────────────────────────── Nomads / several passports ─────────────────────────────
export interface ResidencyComparison {
  ranking: { country: string; countryName: string; verified: boolean; taxDueEur: number; currency: string; taxDue: number; bestTip: string | null }[];
  cheapest: string | null;
  notes: string[];
  reports: TaxReport[];
}

/** Same wallets, several candidate tax residences. Amounts compared in EUR. */
export function compareResidencies(input: Omit<TaxInput, "country">, countries: string[]): ResidencyComparison {
  const uniq = [...new Set(countries.map(normalizeCountry))];
  const reports = uniq.map((c) => computeTax({ ...input, country: c }));
  const fx = input.params?.eurToGbp ?? RULES.GB.defaultEurToGbp;
  const ranking = reports
    .map((r) => ({
      country: r.country, countryName: r.countryName, verified: r.verified,
      taxDueEur: r2(r.currency === "GBP" ? r.totals.taxDue / fx : r.totals.taxDue),
      currency: r.currency, taxDue: r.totals.taxDue,
      bestTip: r.tips.length ? [...r.tips].sort((a, b) => b.saving - a.saving)[0].title : null,
    }))
    .sort((a, b) => Number(b.verified) - Number(a.verified) || a.taxDueEur - b.taxDueEur);
  const notes = [
    "Crypto gains are taxed where you are tax RESIDENT, not by passport: main home, 183-day presence and centre of economic interests decide (tax treaties break ties).",
    "Exception: US citizens are taxed by the US on worldwide gains wherever they live (citizenship-based taxation).",
    "Moving residence mid-year can trigger exit or split-year rules: check before you sell.",
  ];
  if (uniq.includes("GB")) notes.push("UK tax year runs 6 April to 5 April, so the comparison window differs from calendar-year countries.");
  return { ranking, cheapest: ranking.find((r) => r.verified)?.country ?? null, notes, reports };
}

// ───────────────────────────── Generic rule sets (verified 10/11/2026) ─────────────────────────────
/** One rule set per country. All values cross-checked against 2026 sources (see `source`). */
export interface GenericRule {
  name: string;
  /** flat rate, or progressive bands [upToEur, rate] on the year's net gain */
  rate?: number;
  bands?: [number, number][];
  /** gains on lots held MORE than ltDays use ltRate (0 = exempt) */
  ltDays?: number;
  ltRate?: number;
  /** annual exempt amount in EUR; cliff = threshold (all taxed once exceeded) */
  allowanceEur?: number;
  cliff?: boolean;
  c2cTaxable: boolean;
  lossOffset?: boolean;
  assumption?: string;
  notes: string[];
  source: string;
}

export const GENERIC: Record<string, GenericRule> = {
  AE: { name: "United Arab Emirates", rate: 0, c2cTaxable: false, notes: ["No personal income tax or capital gains tax for individuals."], source: "TokenTax 2026; IMI Daily 2026" },
  SG: { name: "Singapore", rate: 0, c2cTaxable: false, notes: ["No capital gains tax for individuals, unless the activity is a trade (then income tax)."], source: "IMI Daily 2026; WhereLegalCrypto (Apr 2026)" },
  HK: { name: "Hong Kong", rate: 0, c2cTaxable: false, notes: ["Territorial system, no capital gains tax; a trading business pays 16.5% profits tax."], source: "TokenTax 2026; IMI Daily 2026" },
  MY: { name: "Malaysia", rate: 0, c2cTaxable: false, notes: ["No capital gains tax for individuals who are not active traders (LHDN)."], source: "WhereLegalCrypto (Apr 2026); dev.to nomad guide 2026" },
  CH: { name: "Switzerland", rate: 0, c2cTaxable: false, notes: ["Private wealth gains are tax-free; professional traders are taxed as income.", "Annual cantonal wealth tax (≈0.1–1%) applies to crypto holdings."], source: "LCX (Mar 2026); WhereLegalCrypto (Apr 2026)" },
  GE: { name: "Georgia", rate: 0, c2cTaxable: false, notes: ["Individual crypto gains are exempt; companies pay 15%."], source: "Koinly (Jan 2026); MEXC 2026" },
  PT: { name: "Portugal", rate: 0.28, ltDays: 364, ltRate: 0, c2cTaxable: false, notes: ["28% on crypto held less than 365 days, exempt from 365 days.", "Crypto-to-crypto swaps are not taxed."], source: "Koinly (Jan 2026); LCX (Mar 2026); KoinX 2026" },
  IT: { name: "Italy", rate: 0.33, c2cTaxable: true, notes: ["33% flat from 2026 (26% for euro e-money stablecoins); the old €2,000 exemption is gone."], source: "KoinX 2026; Mondaq (2026); LCX (Mar 2026)" },
  BE: { name: "Belgium", rate: 0.10, allowanceEur: 10000, c2cTaxable: true, notes: ["New 10% capital gains tax from 1 Jan 2026 above a €10,000 annual exemption; pre-2026 holdings stepped up to their 31 Dec 2025 value.", "Speculative trading: 33%."], source: "CoinTracking deadline calendar 2026" },
  AT: { name: "Austria", rate: 0.275, c2cTaxable: false, notes: ["27.5% flat (KESt), no holding period.", "Crypto bought before 1 Mar 2021 stays tax-free.", "Crypto-to-crypto swaps are tax-neutral."], source: "CoinTracking deadline calendar 2026" },
  IE: { name: "Ireland", rate: 0.33, allowanceEur: 1270, c2cTaxable: true, notes: ["33% Capital Gains Tax; €1,270 annual personal exemption."], source: "KoinX 2026; Mondaq (2026)" },
  ES: { name: "Spain", bands: [[6000, 0.19], [50000, 0.21], [200000, 0.23], [Infinity, 0.28]], c2cTaxable: true, notes: ["Savings scale: 19% to €6k, 21% to €50k, 23% to €200k, 28% above.", "Losses carry forward 4 years."], source: "LCX (Mar 2026); Crypto Tax Europe 2026 guide" },
  NL: { name: "Netherlands", rate: 0, c2cTaxable: false, notes: ["No tax on realised gains: crypto is taxed in Box 3 on a deemed return on net wealth (≈36% of an assumed 6.17% return), above ≈€57,000."], source: "LCX (Mar 2026)" },
  CY: { name: "Cyprus", rate: 0.08, c2cTaxable: true, lossOffset: true, notes: ["8% flat on crypto disposals from 1 Jan 2026; losses offset only within the same year."], source: "LCX (Mar 2026); Mondaq (2026)" },
  PL: { name: "Poland", rate: 0.19, c2cTaxable: false, notes: ["19% flat (PIT-38) on net crypto profit, no holding-period exemption.", "Crypto-to-crypto swaps are not taxed."], source: "Freenance EU 2026 guide" },
  US: { name: "United States", rate: 0.24, ltDays: 365, ltRate: 0.15, c2cTaxable: true, assumption: "assumes the 24% federal bracket (short term) and 15% long-term rate; state tax not included", notes: ["Held ≤ 1 year: ordinary rates 10–37%. Held > 1 year: 0/15/20%.", "US citizens are taxed on worldwide gains wherever they live."], source: "IRS Topic 409 via KoinX 2026; TokenTax 2026 (Rev. Proc. 2025-32)" },
  CA: { name: "Canada", rate: 0.15, c2cTaxable: true, assumption: "50% inclusion × ≈30% combined marginal rate", notes: ["Only 50% of a capital gain is added to income at your marginal rate (adjusted cost base method)."], source: "Crypto tax guide 2026 (CRA rules); MEXC 2026" },
  AU: { name: "Australia", rate: 0.30, ltDays: 365, ltRate: 0.15, c2cTaxable: true, assumption: "assumes the 30% bracket; 50% CGT discount after 12 months", notes: ["Gains taxed at your income rate; 50% CGT discount for assets held over 12 months."], source: "CoinTracking Australia guide (Jan 2026); Crypto tax guide 2026" },
  JP: { name: "Japan", rate: 0.30, c2cTaxable: true, assumption: "miscellaneous income, assumes a ≈30% combined rate (15–55% scale)", notes: ["2026 is a transition year: gains are still miscellaneous income up to 55%; a 20% separate tax is legislated for later."], source: "KoinX 2026; MEXC 2026" },
  IN: { name: "India", rate: 0.30, c2cTaxable: true, lossOffset: false, notes: ["30% flat on virtual digital assets plus 1% TDS; losses cannot offset gains."], source: "KoinX 2026; MEXC 2026" },
  KR: { name: "South Korea", rate: 0, c2cTaxable: false, notes: ["The planned 22% crypto tax is delayed to 2027: no tax on individual gains in 2026."], source: "KoinX 2026" },
};

export function computeGeneric(input: TaxInput, code: string, rule: GenericRule): TaxReport {
  const lots: Record<string, Lot[]> = {};
  const add = (a: string, l: Lot) => (lots[a] ??= []).push(l);
  const taxable: TaxReport["taxableEvents"] = [];
  let st = 0, lt = 0, proceeds = 0;
  const shortList: { asset: string; date: string; gain: number; days: number; freeOn: string }[] = [];
  const gLines: DisposalLine[] = [];
  for (const e of sorted(input.events)) {
    if (e.type === "buy") { add(e.asset, { date: e.date, qty: e.qty, unit: e.eur / e.qty }); continue; }
    const q = lots[e.asset] ?? [];
    let left = e.qty;
    if (e.type === "swap" && !rule.c2cTaxable && e.toAsset) {
      // tax-neutral swap: carry cost and dates to the new asset
      const ratio = (e.toQty ?? 0) / e.qty;
      while (left > 1e-12 && q.length) { const l = q[0], take = Math.min(l.qty, left); add(e.toAsset, { date: l.date, qty: take * ratio, unit: l.unit / ratio }); l.qty -= take; left -= take; if (l.qty <= 1e-12) q.shift(); }
      continue;
    }
    const unitP = e.eur / e.qty, inYear = e.date.startsWith(String(input.year));
    let g = 0;
    while (left > 1e-12 && q.length) {
      const l = q[0], take = Math.min(l.qty, left), gain = take * (unitP - l.unit), held = days(l.date, e.date);
      if (inYear) gLines.push({ date: e.date, asset: e.asset, qty: take, acquired: l.date, proceeds: r2(take * unitP), cost: r2(take * l.unit), gain: r2(gain), term: rule.ltDays !== undefined ? (held > rule.ltDays ? "long" : "short") : undefined });
      if (rule.ltDays !== undefined && held > rule.ltDays) { if (inYear) lt += gain; }
      else if (inYear) { st += gain; if (rule.ltDays !== undefined && gain > 0) shortList.push({ asset: e.asset, date: e.date, gain, days: rule.ltDays + 1 - held, freeOn: addDays(l.date, rule.ltDays + 1) }); }
      g += gain; l.qty -= take; left -= take; if (l.qty <= 1e-12) q.shift();
    }
    if (e.type === "swap" && e.toAsset) add(e.toAsset, { date: e.date, qty: e.toQty ?? 0, unit: e.eur / (e.toQty || 1) });
    if (inYear) { proceeds += e.eur; taxable.push({ date: e.date, asset: e.asset, proceeds: r2(e.eur), gain: r2(g), note: e.type === "swap" ? "swap = disposal" : "sale" }); }
  }
  if (rule.lossOffset === false) { st = taxable.reduce((s, t) => s + Math.max(0, t.gain), 0); lt = 0; }
  const net = st + lt;
  let base = Math.max(0, st), exempt = 0;
  if (rule.allowanceEur) {
    if (rule.cliff) { if (base < rule.allowanceEur) { exempt = base; base = 0; } }
    else { exempt = Math.min(base, rule.allowanceEur); base -= exempt; }
  }
  const taxOn = (b: number) => {
    if (rule.bands) { let t = 0, prev = 0; for (const [cap, r] of rule.bands) { const slice = Math.max(0, Math.min(b, cap) - prev); t += slice * r; prev = cap; if (b <= cap) break; } return t; }
    return b * (rule.rate ?? 0);
  };
  const ltTax = Math.max(0, lt) * (rule.ltRate ?? rule.rate ?? 0);
  const tax = taxOn(base) + ltTax;
  if (rule.ltRate === 0) exempt += Math.max(0, lt);
  const tips: Tip[] = [];
  const effRate = base > 0 ? taxOn(base) / base : rule.rate ?? 0;
  for (const s of shortList) {
    const save = s.gain * (effRate - (rule.ltRate ?? effRate));
    if (save > 0) tips.push({ title: `Wait ${s.days} more day(s) on ${s.asset}`, detail: `Your ${s.asset} disposal on ${s.date} was short of the ${rule.ltDays! + 1}-day rule. From ${s.freeOn} the rate drops to ${Math.round((rule.ltRate ?? 0) * 100)}%.`, saving: r2(Math.min(save, tax)) });
  }
  if (!rule.c2cTaxable && tax > 0) tips.push({ title: "Stay in crypto or stablecoins", detail: "Crypto-to-crypto swaps are not taxed here: only cash-outs to fiat are. Convert only what you need.", saving: r2(tax) });
  if (rule.allowanceEur && !rule.cliff && Math.max(0, st) < rule.allowanceEur) tips.push({ title: `Use your €${rule.allowanceEur.toLocaleString("en-US")} annual exemption`, detail: `You used €${r2(Math.max(0, st))} of it. Realising more gains before 31 December is tax-free up to the limit.`, saving: r2((rule.allowanceEur - Math.max(0, st)) * effRate) });
  return {
    country: code, countryName: rule.name, verified: true, rulesVersion: `${code}-2026.1 (verified 10/11/2026: ${rule.source})`,
    taxYear: String(input.year), currency: "EUR", taxableEvents: taxable, lines: gLines,
    totals: { proceeds: r2(proceeds), netGain: r2(net), exempt: r2(exempt), taxableBase: r2(base + (rule.ltRate ? Math.max(0, lt) : 0)), taxDue: r2(tax), effectiveRate: net > 0 ? r2(tax / net) : 0 },
    rulesApplied: [...rule.notes, ...(rule.assumption ? [`Assumption: ${rule.assumption}`] : []), `Crypto-to-crypto swaps ${rule.c2cTaxable ? "are" : "are not"} taxable`, "Amounts in EUR (converted), FIFO lots"],
    tips, holdings: holdingsList(input), obligations: [`Sources: ${rule.source}`], disclaimer: DISCLAIMER, source: input.source,
  };
}
