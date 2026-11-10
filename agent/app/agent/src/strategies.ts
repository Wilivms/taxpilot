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
function latent(input: TaxInput) {
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
        id: "fr-bareme", title: "Opter pour le barème progressif (case 3CN)",
        why: "La flat tax de 31,4 % est optionnelle : avec une tranche marginale de 0 % ou 11 %, le barème remplace les 12,8 % d'impôt par votre TMI.",
        steps: [`TMI 0 % → ${r2(rows[0].tax)} € au lieu de ${r2(tax)} €`, `TMI 11 % → ${r2(rows[1].tax)} € au lieu de ${r2(tax)} €`, "Cocher 3CN sur la 2042-C (option globale pour toutes vos plus-values crypto de l'année)"],
        saving: r2(Math.max(0, tax - best.tax)), caveat: "Option annuelle et globale : à simuler sur impots.gouv.fr avant de cocher.", source: "Notice 2086 ; CGI art. 200 C",
      });
    }
    if (tax > 0) out.push({
      id: "fr-stable", title: "Encaisser en stablecoins, pas en euros",
      why: "Un échange crypto → crypto, stablecoins compris, est en sursis d'imposition : seule la conversion en euros (ou l'achat d'un bien) est une cession imposable.",
      steps: ["Vendre vers USDT / USDC plutôt que vers l'euro", "Ne convertir en euros que le montant réellement nécessaire", "Lisser les conversions sur plusieurs années civiles"],
      saving: r2(tax), source: "CGI art. 150 VH bis, II-A",
    });
    if (gainLatent > 0 && value > 0) {
      const giftValue = Math.min(value, 100_000);
      const purged = gainLatent * (giftValue / value);
      out.push({
        id: "fr-donation", title: "Donner avant de vendre (donation à un enfant)",
        why: "Le donataire reprend les cryptos à leur valeur au jour de la donation : la plus-value latente est effacée, et l'abattement de 100 000 € par parent et par enfant (tous les 15 ans) évite les droits de donation.",
        steps: [`Valeur donnée : ${r2(giftValue)} € (dans l'abattement)`, "Acte de donation (notaire ou don manuel déclaré) avec la valeur des cryptos au jour J", "C'est l'enfant qui vend ensuite : sa plus-value part de cette valeur"],
        saving: r2(purged * F.flatTax), caveat: "Donation irrévocable : l'argent appartient au donataire. Ne pas la faire juste avant une vente déjà décidée par vous (abus de droit).", source: "CGI art. 150 VH bis III-B ; art. 779 I",
      });
    }
    if (r.totals.proceeds > 305 && r.totals.proceeds < 1000) out.push({
      id: "fr-305", title: "Rester sous 305 € de cessions par an", why: "Si le total des prix de cession du foyer ne dépasse pas 305 € dans l'année, tout est exonéré.",
      steps: [`Cessions ${r.taxYear} : ${r2(r.totals.proceeds)} €`, "Reporter une partie des ventes au 1er janvier"], saving: r2(tax), source: "CGI art. 150 VH bis, II-B",
    });
  }

  if (r.country === "DE") {
    const rate = input.params?.deIncomeTaxRate ?? RULES.DE.defaultIncomeTaxRate;
    const shortGain = r.lines.filter((l) => l.term === "short").reduce((s, l) => s + l.gain, 0);
    const today = new Date().toISOString().slice(0, 10);
    const young = lots.filter((l) => (Date.parse(today) - Date.parse(l.date)) / 864e5 <= 365);
    const youngLoss = young.reduce((s, l) => s + Math.min(0, l.value - l.cost), 0);
    if (shortGain > 0 && youngLoss < 0) out.push({
      id: "de-loss", title: "Verluste vor dem 31.12. realisieren",
      why: "Verluste aus privaten Veräußerungsgeschäften (innerhalb eines Jahres) werden mit Gewinnen desselben Jahres verrechnet; ein Rückkauf danach ist erlaubt.",
      steps: young.filter((l) => l.value < l.cost).map((l) => `${l.asset}: ${r2(l.value - l.cost)} € unrealisierter Verlust`), saving: r2(Math.min(-youngLoss, shortGain) * rate), source: "§ 23 Abs. 3 EStG",
    });
    if (shortGain >= 1000 && shortGain < 2000) out.push({
      id: "de-spouse", title: "Freigrenze zweimal nutzen (Ehepaar)",
      why: "Die Freigrenze von 1.000 € gilt pro Person: bei gemeinsamen Konten wird der Gewinn je zur Hälfte zugerechnet.",
      steps: ["Kryptowerte über ein gemeinsames Konto / Wallet beider Ehegatten halten", `Gewinn ${r2(shortGain)} € → je ${r2(shortGain / 2)} € unter der Freigrenze`], saving: r2(tax), caveat: "Nur bei echtem gemeinsamem Eigentum (z. B. Gemeinschaftskonto); keine Scheinübertragung.", source: "Freigrenze je Ehegatte (Lohnsteuer kompakt 2025); Anlage SO Z. 47",
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
