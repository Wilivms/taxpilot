/**
 * TaxPilot — legal tax-optimisation strategies, computed on the user's own numbers.
 *
 * Each strategy states the rule it relies on, the concrete steps, and the saving
 * computed by fixed code. Sources checked on 11/11/2026:
 *  - FR: CGI art. 150 VH bis (III-B: acquisition à titre gratuit = valeur DMTG), art. 779 I
 *        (abattement 100 000 € parent → enfant, tous les 15 ans), notice 2086 (option barème, case 3CN)
 *  - DE: § 23 EStG (1-year rule, €1,000 Freigrenze per person, losses only offset private sales)
 *  - UK: HMRC CGT rules (no gain / no loss between spouses, 30-day "bed and breakfast" rule, £3,000 AEA)
 *  - US: digital assets are property (no wash-sale rule under current IRS guidance; proposals pending),
 *        long-term rates after 1 year, gifts of appreciated long-term property to a charity at fair value
 */
import { RULES, type TaxInput, type TaxReport } from "./taxEngine.js";

export interface Strategy {
  id: string;
  title: string;
  why: string; // the legal mechanism, one sentence
  steps: string[];
  saving: number; // in report currency, computed
  caveat?: string;
  source: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Current holdings with latent gain/loss from the engine's own cost data. */
export function latent(input: TaxInput) {
  const lots: Record<string, { qty: number; cost: number; date: string }[]> = {};
  for (const e of [...input.events].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.type === "buy") { (lots[e.asset] ??= []).push({ qty: e.qty, cost: e.eur, date: e.date }); continue; }
    let left = e.qty;
    const q = lots[e.asset] ?? [];
    while (left > 1e-12 && q.length) {
      const l = q[0], take = Math.min(l.qty, left), part = l.cost * (take / l.qty);
      if (e.type === "swap" && e.toAsset) (lots[e.toAsset] ??= []).push({ qty: (e.toQty ?? 0) * (take / e.qty), cost: part, date: l.date });
      l.cost -= part; l.qty -= take; left -= take;
      if (l.qty <= 1e-12) q.shift();
    }
  }
  const out: { asset: string; qty: number; cost: number; value: number; date: string }[] = [];
  for (const [a, q] of Object.entries(lots)) for (const l of q) if (l.qty > 1e-9) out.push({ asset: a, qty: l.qty, cost: l.cost, value: l.qty * (input.currentPrices[a] ?? 0), date: l.date });
  return out;
}

export function strategies(r: TaxReport, input: TaxInput): Strategy[] {
  const out: Strategy[] = [];
  const lots = latent(input);
  const value = lots.reduce((s, l) => s + l.value, 0);
  const cost = lots.reduce((s, l) => s + l.cost, 0);
  const gainLatent = value - cost;
  const tax = r.totals.taxDue;

  if (r.country === "FR") {
    const F = RULES.FR;
    const base = r.totals.taxableBase;
    if (base > 0) {
      const rows = [0, 0.11].map((tmi) => ({ tmi, tax: base * (tmi + F.social) }));
      const best = rows[0];
      out.push({
        id: "fr-bareme", title: "Opt for the progressive scale (box 3CN)",
        why: "The 31.4% flat tax is optional: with a 0% or 11% marginal bracket, the progressive scale replaces the 12.8% income tax with your bracket.",
        steps: [`0% bracket → €${r2(rows[0].tax)} instead of €${r2(tax)}`, `11% bracket → €${r2(rows[1].tax)} instead of €${r2(tax)}`, "Tick box 3CN on form 2042-C (applies to all your capital income of the year)"],
        saving: r2(Math.max(0, tax - best.tax)), caveat: "Annual, all-or-nothing option: simulate it on impots.gouv.fr before ticking.", source: "Notice 2086 ; CGI art. 200 C",
      });
    }
    if (tax > 0) out.push({
      id: "fr-stable", title: "Cash out to stablecoins, not euros",
      why: "A crypto → crypto swap, stablecoins included, is tax-deferred: only converting to euros (or buying goods) is a taxable disposal.",
      steps: ["Sell into USDT / USDC rather than euros", "Only convert to euros the amount you really need", "Spread conversions over several calendar years"],
      saving: r2(tax), source: "CGI art. 150 VH bis, II-A",
    });
    if (gainLatent > 0 && value > 0) {
      const giftValue = Math.min(value, 100_000);
      const purged = gainLatent * (giftValue / value);
      out.push({
        id: "fr-donation", title: "Gift before selling (donation to a child)",
        why: "The recipient takes the crypto at its value on the gift date: the latent gain is wiped out, and the €100,000 allowance per parent per child (every 15 years) avoids gift duty.",
        steps: [`Value gifted: €${r2(giftValue)} (within the allowance)`, "Gift deed (notary or declared manual gift) stating the crypto value on the day", "The child sells afterwards: their gain starts from that value"],
        saving: r2(purged * F.flatTax), caveat: "Irrevocable: the money belongs to the child. Do not gift right before a sale you already decided yourself (abuse of law).", source: "CGI art. 150 VH bis III-B ; art. 779 I",
      });
    }
    if (r.totals.proceeds > 305 && r.totals.proceeds < 1000) out.push({
      id: "fr-305", title: "Stay under €305 of disposals per year", why: "If the household's total disposal proceeds stay at or below €305 in the year, everything is exempt.",
      steps: [`Disposals ${r.taxYear}: €${r2(r.totals.proceeds)}`, "Push part of the sales to 1 January"], saving: r2(tax), source: "CGI art. 150 VH bis, II-B",
    });
  }

  if (r.country === "DE") {
    const rate = input.params?.deIncomeTaxRate ?? RULES.DE.defaultIncomeTaxRate;
    const shortGain = r.lines.filter((l) => l.term === "short").reduce((s, l) => s + l.gain, 0);
    const today = new Date().toISOString().slice(0, 10);
    const young = lots.filter((l) => (Date.parse(today) - Date.parse(l.date)) / 864e5 <= 365);
    const youngLoss = young.reduce((s, l) => s + Math.min(0, l.value - l.cost), 0);
    if (shortGain > 0 && youngLoss < 0) out.push({
      id: "de-loss", title: "Realise losses before 31 December",
      why: "Losses on private sales (held under a year) offset gains of the same year; buying back afterwards is allowed.",
      steps: young.filter((l) => l.value < l.cost).map((l) => `${l.asset}: €${r2(l.value - l.cost)} unrealised loss`), saving: r2(Math.min(-youngLoss, shortGain) * rate), source: "§ 23 Abs. 3 EStG",
    });
    if (shortGain >= 1000 && shortGain < 2000) out.push({
      id: "de-spouse", title: "Use the €1,000 threshold twice (married couple)",
      why: "The €1,000 Freigrenze applies per person: on joint accounts the gain is split half and half.",
      steps: ["Hold the crypto in a joint account / wallet of both spouses", `Gain €${r2(shortGain)} → €${r2(shortGain / 2)} each, under the threshold`], saving: r2(tax), caveat: "Only with genuine joint ownership (e.g. joint account); no sham transfers.", source: "Freigrenze je Ehegatte (Lohnsteuer kompakt 2025); Anlage SO Z. 47",
    });
  }

  if (r.country === "GB") {
    const fx = input.params?.eurToGbp ?? RULES.GB.defaultEurToGbp;
    const loss = lots.reduce((s, l) => s + Math.min(0, l.value - l.cost), 0) * fx;
    if (tax > 0 && loss < 0) out.push({
      id: "uk-harvest", title: "Harvest losses before 5 April (respecting the 30-day rule)",
      why: "Losses offset gains of the same tax year; rebuying the same token within 30 days would match the new purchase instead, so wait 31 days or buy a different asset.",
      steps: lots.filter((l) => l.value < l.cost).map((l) => `${l.asset}: £${r2((l.value - l.cost) * fx)} unrealised`), saving: r2(Math.min(-loss, r.totals.taxableBase) * (input.params?.ukHigherRate === false ? RULES.GB.basicRate : RULES.GB.higherRate)), source: "HMRC Cryptoassets Manual (same-day and 30-day matching rules)",
    });
  }

  if (r.country === "US") {
    const loss = lots.reduce((s, l) => s + Math.min(0, l.value - l.cost), 0);
    if (tax > 0 && loss < 0) out.push({
      id: "us-harvest", title: "Tax-loss harvesting",
      why: "Crypto is property, not a security: under current IRS guidance the wash-sale rule does not apply, so a loss can be realised and the token bought back.",
      steps: lots.filter((l) => l.value < l.cost).map((l) => `${l.asset}: €${r2(l.value - l.cost)} unrealised`), saving: r2(Math.min(-loss, r.totals.netGain) * 0.24), caveat: "Proposed rules could extend wash sales to digital assets: check the year's IRS guidance.", source: "IRS Notice 2014-21; Form 8949 instructions",
    });
    const longGainLots = lots.filter((l) => (Date.now() - Date.parse(l.date)) / 864e5 > 365 && l.value > l.cost);
    const lg = longGainLots.reduce((s, l) => s + (l.value - l.cost), 0);
    if (lg > 0) out.push({
      id: "us-charity", title: "Donate appreciated crypto instead of cash",
      why: "Giving long-term appreciated crypto to a qualified charity avoids the capital-gains tax on the appreciation and can be deducted at fair market value (if you itemise).",
      steps: [`Long-term appreciated holdings: €${r2(lg)} of untaxed gain`, "Transfer the tokens directly to the charity's wallet (do not sell first)", "Over $5,000: get a qualified appraisal (Form 8283)"],
      saving: r2(lg * 0.15), source: "IRS Pub. 526; Form 8283",
    });
  }

  // all countries with a holding-period exemption: the calendar of tax-free dates is the strongest lever
  const ltDays = r.country === "DE" ? 365 : r.country === "PT" ? 364 : r.country === "CZ" ? 1095 : undefined;
  if (ltDays !== undefined && gainLatent > 0) {
    const pending = lots.filter((l) => l.value > l.cost && (Date.now() - Date.parse(l.date)) / 864e5 <= ltDays);
    if (pending.length) out.push({
      id: "hold-calendar", title: "Tax-free date calendar",
      why: `Gains on assets held more than ${ltDays + 1 >= 365 ? Math.round((ltDays + 1) / 365) + " year(s)" : ltDays + " days"} are exempt here: selling one day after the date costs nothing.`,
      steps: pending.map((l) => `${l.asset} bought ${l.date}: tax-free from ${new Date(Date.parse(l.date) + (ltDays + 1) * 864e5).toISOString().slice(0, 10)} (latent gain €${r2(l.value - l.cost)})`),
      saving: r2(pending.reduce((s, l) => s + (l.value - l.cost), 0) * (r.country === "DE" ? (input.params?.deIncomeTaxRate ?? RULES.DE.defaultIncomeTaxRate) : 0.28)), source: r.country === "DE" ? "§ 23 Abs. 1 Nr. 2 EStG" : "Código do IRS art. 10 (crypto held 365 days or more)",
    });
  }
  return out.sort((a, b) => b.saving - a.saving);
}
