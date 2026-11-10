/**
 * Wallet → TaxEvent[] (read-only, BSC mainnet).
 *
 * Transfers come from the Etherscan v2 multichain API (chainid 56). NOTE: since
 * late 2025 BNB Chain is NOT on Etherscan's free tier: a paid key (Lite plan) is
 * needed. Free alternative to wire next: BSCTrace via NodeReal MegaNode
 * (nr_getAssetTransfers on https://bsc-mainnet.nodereal.io/v1/<key>). Daily EUR prices come from CoinGecko's public API.
 * Supported assets: BNB + major BSC tokens below; others are listed as
 * "unpriced" in the report instead of being guessed.
 *
 * Classification (best effort, flagged as such in the report):
 *  - same tx hash with one asset out and one asset in → swap
 *  - incoming only → acquisition at market value
 *  - outgoing only → disposal at market value
 */
import { readFileSync } from "node:fs";
import type { TaxEvent, TaxInput } from "./taxEngine.js";
import { ALCHEMY_KEY } from "./localKeys.js";

/** Etherscan key: env var first, else app/agent/etherscan.key (one line). The BNB
 *  trial only ships a fixed list of runtime secrets, so the file rides in the code zip. */
function readKey(env: string, file: string): string | undefined {
  if (process.env[env]) return process.env[env]!.trim();
  for (const rel of [`../${file}`, `./${file}`]) {
    try { const k = readFileSync(new URL(rel, import.meta.url), "utf-8").trim(); if (k) return k; } catch { /* next */ }
  }
  try { const k = readFileSync(file, "utf-8").trim(); if (k) return k; } catch { /* none */ }
  return undefined;
}
const etherscanKey = () => readKey("ETHERSCAN_API_KEY", "etherscan.key");
const alchemyKey = () => readKey("ALCHEMY_API_KEY", "alchemy.key") ?? (ALCHEMY_KEY || undefined);

/** Free path: Alchemy Transfers API on BSC mainnet (alchemy_getAssetTransfers) + block timestamps. */
async function alchemyLegs(addr: string, key: string): Promise<Leg[]> {
  const url = `https://bnb-mainnet.g.alchemy.com/v2/${key}`;
  const rpc = async (body: unknown) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Alchemy HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  type T = { hash: string; blockNum: string; from: string; to: string; value: number | null; asset: string | null; category: string; rawContract?: { address?: string | null }; metadata?: { blockTimestamp?: string } };
  const all: { t: T; dir: 1 | -1 }[] = [];
  for (const [side, dir] of [["toAddress", 1], ["fromAddress", -1]] as const) {
    let pageKey: string | undefined;
    for (let page = 0; page < 5; page++) {
      const j = await rpc({ jsonrpc: "2.0", id: 1, method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", [side]: addr, category: ["external", "erc20"], excludeZeroValue: true, withMetadata: true, maxCount: "0x3e8", order: "desc", ...(pageKey ? { pageKey } : {}) }] });
      if (j.error) throw new Error(`Alchemy: ${j.error.message}`);
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
      let old = false;
      for (const t of (j.result?.transfers ?? []) as T[]) {
        const d = t.metadata?.blockTimestamp?.slice(0, 10);
        if (d && d < cutoff) { old = true; break; }
        const known = t.category === "external" || BSC_TOKENS[(t.rawContract?.address ?? "").toLowerCase()];
        if (t.value && known) all.push({ t, dir });
      }
      pageKey = j.result?.pageKey;
      if (!pageKey || old) break;
    }
  }
  // block → date (batched JSON-RPC)
  const ts = new Map<string, string>();
  for (const { t } of all) if (t.metadata?.blockTimestamp) ts.set(t.blockNum, t.metadata.blockTimestamp.slice(0, 10));
  const blocks = [...new Set(all.map((x) => x.t.blockNum))].filter((b) => !ts.has(b));
  for (let i = 0; i < blocks.length; i += 100) {
    const batch = blocks.slice(i, i + 100).map((b, k) => ({ jsonrpc: "2.0", id: k, method: "eth_getBlockByNumber", params: [b, false] }));
    const res = (await rpc(batch)) as { id: number; result?: { timestamp: string } }[];
    for (const r of res) if (r.result) ts.set(batch[r.id].params[0] as string, new Date(parseInt(r.result.timestamp, 16) * 1000).toISOString().slice(0, 10));
  }
  return all.filter((x) => ts.has(x.t.blockNum)).map(({ t, dir }) => ({ hash: t.hash, date: ts.get(t.blockNum)!, symbol: t.category === "external" ? "BNB" : BSC_TOKENS[(t.rawContract?.address ?? "").toLowerCase()], qty: Number(t.value), dir }));
}

const COINGECKO_ID: Record<string, string> = {
  BNB: "binancecoin", WBNB: "binancecoin", USDT: "tether", "BSC-USD": "tether",
  USDC: "usd-coin", FDUSD: "first-digital-usd", CAKE: "pancakeswap-token",
  ETH: "ethereum", BTCB: "bitcoin", XRP: "ripple", DOGE: "dogecoin",
};

/** Official BSC contracts only: fake tokens re-using a symbol (spam airdrops) are ignored. */
const BSC_TOKENS: Record<string, string> = {
  "0x55d398326f99059ff775485246999027b3197955": "USDT",
  "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": "USDC",
  "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": "FDUSD",
  "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "CAKE",
  "0x2170ed0880ac9a755fd29b2688956bd959f933f8": "ETH",
  "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c": "BTCB",
  "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c": "WBNB",
};
const WINDOW_DAYS = 365; // free price history window

const seriesCache = new Map<string, Map<string, number>>();

/** One CoinGecko call per asset: daily EUR prices over the last 365 days (free/demo API window). */
async function eurSeries(id: string): Promise<Map<string, number>> {
  const hit = seriesCache.get(id);
  if (hit) return hit;
  const to = Math.floor(Date.now() / 1000), from = to - 365 * 86400;
  let res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=eur&from=${from}&to=${to}`);
  for (let i = 0; i < 3 && res.status === 429; i++) {
    await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart/range?vs_currency=eur&from=${from}&to=${to}`);
  }
  const m = new Map<string, number>();
  if (res.ok) {
    const j = (await res.json()) as { prices?: [number, number][] };
    for (const [ms, p] of j.prices ?? []) m.set(new Date(ms).toISOString().slice(0, 10), p);
  }
  seriesCache.set(id, m);
  return m;
}

async function eurPrice(symbol: string, date: string): Promise<number | null> {
  const id = COINGECKO_ID[symbol.toUpperCase()];
  if (!id) return null;
  const m = await eurSeries(id);
  if (m.has(date)) return m.get(date)!;
  // nearest earlier day (today's point may be missing)
  const keys = [...m.keys()].filter((k) => k <= date).sort();
  return keys.length ? m.get(keys[keys.length - 1])! : null;
}

async function etherscan(params: Record<string, string>): Promise<Record<string, string>[]> {
  const key = etherscanKey();
  if (!key) throw new Error("ETHERSCAN_API_KEY is not set (BNB Chain needs a paid Etherscan plan): live wallet analysis is unavailable");
  const qs = new URLSearchParams({ chainid: "56", module: "account", sort: "asc", apikey: key, ...params });
  const res = await fetch(`https://api.etherscan.io/v2/api?${qs}`);
  const j = (await res.json()) as { status: string; message?: string; result: unknown };
  if (j.status === "0" && typeof j.result === "string" && /not supported|upgrade|invalid/i.test(j.result)) throw new Error(`Etherscan: ${j.result}`);
  return Array.isArray(j.result) ? (j.result as Record<string, string>[]) : [];
}

interface Leg { hash: string; date: string; symbol: string; qty: number; dir: 1 | -1 }

export interface WhatIf { costPerUnitEur: number; acquiredOn: string; label?: string }

export async function walletInput(country: string, year: number, wallets: string[], whatIf?: WhatIf): Promise<{ input: TaxInput; unpriced: string[] }> {
  const legs: Leg[] = [];
  const own = new Set(wallets.map((w) => w.toLowerCase()));
  const ak = alchemyKey();
  if (!etherscanKey() && !ak) throw new Error("no data key: put a free Alchemy key in app/agent/alchemy.key (or a paid Etherscan key in etherscan.key)");
  for (const w of wallets) {
    const addr = w.toLowerCase();
    if (!etherscanKey() && ak) {
      for (const l of await alchemyLegs(addr, ak)) legs.push(l);
      continue;
    }
    for (const t of await etherscan({ action: "txlist", address: addr })) {
      const v = Number(t.value) / 1e18;
      if (!v || t.isError === "1") continue;
      const from = t.from.toLowerCase(), to = (t.to ?? "").toLowerCase();
      if (own.has(from) && own.has(to)) continue; // internal move between own wallets
      legs.push({ hash: t.hash, date: new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10), symbol: "BNB", qty: v, dir: to === addr ? 1 : -1 });
    }
    for (const t of await etherscan({ action: "tokentx", address: addr })) {
      const v = Number(t.value) / 10 ** Number(t.tokenDecimal || 18);
      if (!v) continue;
      const from = t.from.toLowerCase(), to = t.to.toLowerCase();
      if (own.has(from) && own.has(to)) continue;
      const sym = BSC_TOKENS[(t.contractAddress ?? "").toLowerCase()];
      if (!sym) continue;
      legs.push({ hash: t.hash, date: new Date(Number(t.timeStamp) * 1000).toISOString().slice(0, 10), symbol: sym, qty: v, dir: to === addr ? 1 : -1 });
    }
  }
  const byHash = new Map<string, Leg[]>();
  for (const l of legs) (byHash.get(l.hash) ?? byHash.set(l.hash, []).get(l.hash)!).push(l);

  const events: TaxEvent[] = [];
  const prices: TaxInput["prices"] = {};
  const unpriced = new Set<string>();
  const px = async (s: string, d: string) => {
    const p = await eurPrice(s, d);
    if (p === null) { unpriced.add(s); return null; }
    (prices[d] ??= {})[s] = p;
    return p;
  };
  for (const [hash, ls] of byHash) {
    const outs = ls.filter((l) => l.dir === -1), ins = ls.filter((l) => l.dir === 1);
    if (outs.length === 1 && ins.length === 1 && outs[0].symbol !== ins[0].symbol) {
      const p = await px(outs[0].symbol, outs[0].date);
      if (p !== null) events.push({ date: outs[0].date, type: "swap", asset: outs[0].symbol, qty: outs[0].qty, eur: outs[0].qty * p, toAsset: ins[0].symbol, toQty: ins[0].qty, tx: hash });
      continue;
    }
    for (const l of ls) {
      const p = await px(l.symbol, l.date);
      if (p === null) continue;
      events.push({ date: l.date, type: l.dir === 1 ? "buy" : "sell", asset: l.symbol, qty: l.qty, eur: l.qty * p, tx: hash });
    }
  }
  // Cap disposals to what the window shows was acquired: older holdings have no known cost basis.
  events.sort((a, b) => a.date.localeCompare(b.date));
  const bal: Record<string, number> = {};
  let excessEur = 0;
  const kept: TaxEvent[] = [];
  for (const e of events) {
    if (e.type === "buy") { bal[e.asset] = (bal[e.asset] ?? 0) + e.qty; kept.push(e); continue; }
    let have = Math.max(0, bal[e.asset] ?? 0);
    if (whatIf && have < e.qty) {
      // what-if: the missing part was bought at the assumed price on the assumed date
      const miss = e.qty - have;
      kept.unshift({ date: whatIf.acquiredOn, type: "buy", asset: e.asset, qty: miss, eur: miss * whatIf.costPerUnitEur });
      have = e.qty;
    }
    const q = Math.min(e.qty, have);
    if (q < e.qty) excessEur += e.eur * (1 - q / e.qty);
    if (q <= 1e-12) continue;
    const k = q / e.qty;
    kept.push({ ...e, qty: q, eur: e.eur * k, toQty: e.toQty !== undefined ? e.toQty * k : undefined });
    bal[e.asset] = have - q;
    if (e.type === "swap" && e.toAsset) bal[e.toAsset] = (bal[e.toAsset] ?? 0) + (e.toQty ?? 0) * k;
  }
  events.length = 0; events.push(...kept);
  if (excessEur > 0) unpriced.add(`__excess:${Math.round(excessEur)}`);
  const today = new Date().toISOString().slice(0, 10);
  const currentPrices: Record<string, number> = {};
  for (const s of new Set(events.map((e) => e.toAsset ?? e.asset).concat(events.map((e) => e.asset)))) {
    const p = await eurPrice(s, today);
    if (p !== null) currentPrices[s] = p;
  }
  // make sure every sale date has prices for all held assets (FR global portfolio value)
  const cutoffDay = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  for (const e of events) {
    if (e.date < cutoffDay) continue; // what-if acquisitions: no price history needed
    for (const s of Object.keys(currentPrices)) if (!(prices[e.date] ?? {})[s]) await px(s, e.date);
  }
  return {
    input: { country, year, events, prices, currentPrices, source: `live BSC wallets ${wallets.join(", ")}${whatIf ? ` [WHAT-IF: outflows treated as sales; older holdings assumed bought on ${whatIf.acquiredOn} at €${whatIf.costPerUnitEur}/unit${whatIf.label ? " (" + whatIf.label + ")" : ""}]` : ""}: last ${WINDOW_DAYS} days, tokens BNB/${[...new Set(Object.values(BSC_TOKENS))].join("/")} (official contracts); incoming = acquisition at market value, outgoing = disposal; earlier holdings have no cost basis` },
    unpriced: [...unpriced],
  };
}
