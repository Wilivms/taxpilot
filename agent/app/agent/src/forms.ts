/**
 * TaxPilot — tax form generator.
 *
 * Turns a TaxReport into the official form entries of the country, line by line,
 * plus a CSV ledger of every disposal (to attach or transcribe).
 *
 * Line / box numbers verified on 11/11/2026 against:
 *  - FR: formulaire 2086 (cerfa 16043*07, revenus 2025) + notice 2086; 2042-C cases 3AN / 3BN / 3CN; 3916-bis
 *  - DE: Anlage SO 2025, Kryptowerte section, Zeilen 47–51 (Waltio / stock3 guides 2026)
 *  - UK: SA108 2026 (HMRC 12/25), cryptoassets boxes 13.1–13.5
 *  - US: Form 8949 (2025 instructions), digital-asset boxes I (short) / L (long) when no 1099-DA; totals to Schedule D
 */
import type { DisposalLine, TaxReport } from "./taxEngine.js";

export interface FormField { code: string; label: string; value: string | number }
export interface TaxForm {
  id: string;
  title: string;
  url?: string;
  fields?: FormField[];
  /** one row per cession / lot */
  table?: { columns: string[]; rows: (string | number)[][] };
  notes?: string[];
}
export interface FormPack { country: string; currency: string; forms: TaxForm[]; csv: string; deadline?: string }

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: number[]) => r2(xs.reduce((a, b) => a + b, 0));
const dmy = (iso: string) => iso.split("-").reverse().join("/");

function ledgerCsv(lines: DisposalLine[], currency: string): string {
  const head = ["date_sold", "asset", "quantity", "date_acquired", "term", `proceeds_${currency}`, `cost_${currency}`, `gain_${currency}`];
  const rows = lines.map((l) => [l.date, l.asset, r2(l.qty), l.acquired ?? "", l.term ?? "", l.proceeds, l.cost, l.gain]);
  return [head, ...rows].map((r) => r.join(",")).join("\n");
}

function franceForms(r: TaxReport, foreignPlatforms: string[]): TaxForm[] {
  const ls = r.lines.filter((l) => l.fr);
  const total = sum(ls.map((l) => l.fr!.l224));
  const exempt = r.totals.proceeds <= 305;
  const forms: TaxForm[] = [];
  forms.push({
    id: "FR-2086",
    title: "Formulaire 2086 — plus ou moins-values de cessions d'actifs numériques",
    url: "https://www.impots.gouv.fr/formulaire/2086/declaration-des-plus-ou-moins-values-realisees-sur-actifs-numeriques",
    table: {
      columns: ["Ligne", ...ls.map((_, i) => `Cession ${i + 1}`)],
      rows: [
        ["211 Date de la cession", ...ls.map((l) => l.fr!.l211)],
        ["212 Valeur globale du portefeuille", ...ls.map((l) => l.fr!.l212)],
        ["213 Prix de cession", ...ls.map((l) => l.fr!.l213)],
        ["214 Frais de cession", ...ls.map((l) => l.fr!.l214)],
        ["216 Soulte reçue ou versée", ...ls.map((l) => l.fr!.l216)],
        ["217 Prix de cession net des soultes", ...ls.map((l) => l.fr!.l217)],
        ["218 Prix de cession net des frais et soultes", ...ls.map((l) => l.fr!.l218)],
        ["220 Prix total d'acquisition", ...ls.map((l) => l.fr!.l220)],
        ["221 Fractions de capital initial", ...ls.map((l) => l.fr!.l221)],
        ["222 Soultes reçues antérieurement", ...ls.map((l) => l.fr!.l222)],
        ["223 Prix total d'acquisition net (220 − 221 − 222)", ...ls.map((l) => l.fr!.l223)],
        ["224 Plus ou moins-value = 218 − [223 × 217 / 212]", ...ls.map((l) => l.fr!.l224)],
      ],
    },
    fields: [{ code: "52", label: "Total des plus et moins-values du foyer", value: total }],
    notes: [
      "Five cessions per column block on the paper form: continue on a new page beyond five (over 200 cessions online: attach the detail as a file).",
      "Fees (214) are set to 0: add your exchange fees if you have the receipts, they reduce the gain.",
      ...(exempt ? ["Total cessions ≤ 305 €: exempt, but the 2086 can still be filed."] : []),
    ],
  });
  forms.push({
    id: "FR-2042C",
    title: "Déclaration 2042-C (report du résultat)",
    fields: [
      { code: "3AN", label: "Plus-value nette (si positive)", value: total > 0 && !exempt ? total : 0 },
      { code: "3BN", label: "Moins-value nette (si négative)", value: total < 0 ? -total : 0 },
      { code: "3CN", label: "Option pour le barème progressif (à cocher si plus favorable)", value: "voir stratégie « barème »" },
    ],
  });
  forms.push({
    id: "FR-3916bis",
    title: "Formulaire 3916-bis — comptes d'actifs numériques à l'étranger (+ case 8UU de la 2042)",
    url: "https://www.impots.gouv.fr/formulaire/3916-3916-bis/declaration-par-un-resident-dun-compte-ouvert-hors-de-france",
    table: { columns: ["Plateforme / compte", "À déclarer"], rows: foreignPlatforms.length ? foreignPlatforms.map((p) => [p, "oui, même sans cession"]) : [["Aucune plateforme étrangère détectée dans ces wallets", "—"]] },
    notes: ["A self-custody wallet (MetaMask, Ledger) is not a foreign account; exchange accounts outside France are."],
  });
  return forms;
}

function germanyForms(r: TaxReport): TaxForm[] {
  const short = r.lines.filter((l) => l.term === "short");
  const gain = sum(short.map((l) => l.gain));
  return [{
    id: "DE-AnlageSO",
    title: "Anlage SO — private Veräußerungsgeschäfte, Kryptowerte (§ 23 EStG)",
    url: "https://www.elster.de",
    fields: [
      { code: "Z. 47", label: "Zeitraum (Anschaffung / Veräußerung)", value: short.length ? `${dmy(short.map((l) => l.acquired!).sort()[0])} – ${dmy(short.map((l) => l.date).sort().slice(-1)[0])}` : "—" },
      { code: "Z. 48", label: "Veräußerungspreis", value: sum(short.map((l) => l.proceeds)) },
      { code: "Z. 49", label: "Anschaffungskosten", value: sum(short.map((l) => l.cost)) },
      { code: "Z. 50", label: "Werbungskosten (Gebühren)", value: 0 },
      { code: "Z. 51", label: "Gewinn / Verlust", value: gain },
    ],
    table: { columns: ["Veräußert", "Kryptowert", "Menge", "Angeschafft", "Erlös €", "Kosten €", "Gewinn €"], rows: short.map((l) => [dmy(l.date), l.asset, r2(l.qty), dmy(l.acquired!), l.proceeds, l.cost, l.gain]) },
    notes: [
      "Only disposals within the one-year holding period go here; lots held over a year are tax-free and not entered.",
      gain < 1000 && gain > 0 ? "Total below the €1,000 Freigrenze: tax-free, but declaring it is still recommended." : "Losses: enter them (negative) so the Finanzamt records them for future years.",
      "Attach the transaction list (table above / CSV) as 'Steuerreport'.",
    ],
  }];
}

function ukForms(r: TaxReport): TaxForm[] {
  const ls = r.lines;
  return [{
    id: "UK-SA108",
    title: "SA108 Capital Gains summary — cryptoassets section",
    url: "https://www.gov.uk/government/publications/self-assessment-capital-gains-summary-sa108",
    fields: [
      { code: "13.1", label: "Number of disposals", value: ls.length },
      { code: "13.2", label: "Disposal proceeds (£)", value: sum(ls.map((l) => l.proceeds)) },
      { code: "13.3", label: "Allowable costs, including purchase price (£)", value: sum(ls.map((l) => l.cost)) },
      { code: "13.4", label: "Gains in the year, before losses (£)", value: sum(ls.map((l) => Math.max(0, l.gain))) },
      { code: "13.5", label: "Losses in the year (£)", value: sum(ls.map((l) => Math.max(0, -l.gain))) },
    ],
    table: { columns: ["Date", "Asset", "Quantity", "Proceeds £", "Pool cost £", "Gain £"], rows: ls.map((l) => [dmy(l.date), l.asset, r2(l.qty), l.proceeds, l.cost, l.gain]) },
    notes: ["Enclose the computation (table above) with the return. File online by 31 January after the tax year.", "Required when gains exceed £3,000 or total proceeds exceed £50,000."],
  }];
}

function usForms(r: TaxReport): TaxForm[] {
  const part = (term: "short" | "long") => r.lines.filter((l) => l.term === term).map((l) => [`${r2(l.qty)} ${l.asset}`, l.acquired ?? "VARIOUS", l.date, l.proceeds, l.cost, "", "", l.gain]);
  const cols = ["(a) Description", "(b) Date acquired", "(c) Date sold", "(d) Proceeds", "(e) Cost basis", "(f) Code", "(g) Adjustment", "(h) Gain or loss"];
  return [
    { id: "US-8949-I", title: "Form 8949, Part I — short-term, box I (digital assets, no Form 1099-DA)", url: "https://www.irs.gov/forms-pubs/about-form-8949", table: { columns: cols, rows: part("short") } },
    { id: "US-8949-L", title: "Form 8949, Part II — long-term, box L (digital assets, no Form 1099-DA)", table: { columns: cols, rows: part("long") },
      notes: ["Self-custody / on-chain trades use boxes I and L; if an exchange sent you a 1099-DA, use boxes G/H (short) or J/K (long) for those trades instead.", "Amounts are in EUR here: convert each row to USD at the rate of the transaction date before filing.", "Totals of each part carry to Schedule D."] },
  ];
}

export function buildForms(r: TaxReport, foreignPlatforms: string[] = []): FormPack {
  const forms =
    r.country === "FR" ? franceForms(r, foreignPlatforms)
    : r.country === "DE" ? germanyForms(r)
    : r.country === "GB" ? ukForms(r)
    : r.country === "US" ? usForms(r)
    : [{ id: `${r.country}-ledger`, title: `${r.countryName}: disposal ledger to transcribe into your national return`, table: { columns: ["Date", "Asset", "Quantity", "Acquired", "Term", "Proceeds", "Cost", "Gain"], rows: r.lines.map((l) => [l.date, l.asset, r2(l.qty), l.acquired ?? "", l.term ?? "", l.proceeds, l.cost, l.gain]) }, notes: ["Line-by-line form mapping is available for France, Germany, the UK and the US; for this country TaxPilot gives the computed ledger."] }];
  const deadline = r.country === "FR" ? "Déclaration en ligne : mai–juin de l'année suivante" : r.country === "DE" ? "31 July of the following year (without adviser)" : r.country === "GB" ? "31 January after the tax year (online)" : r.country === "US" ? "15 April of the following year" : undefined;
  return { country: r.country, currency: r.currency, forms, csv: ledgerCsv(r.lines, r.currency), deadline };
}
