/**
 * TaxPilot guardrails service — speaks Otari's guardrails contract:
 *   POST {url}/validate  {profile, input_text, validate_kwargs} -> {profile, result:{valid, explanation, score}}
 *   GET  {url}/profiles  -> [{name, guardrail_name}]
 *
 * Otari calls it BEFORE any model provider sees the request (block mode -> 403).
 * Profiles are specific to a crypto-tax copilot:
 *   - crypto-secrets   : seed phrases, private keys, xprv keys must never reach a model provider
 *   - prompt-injection : attempts to override the copilot's instructions or tool use
 *   - tax-evasion      : requests to hide income from the tax authority (we only help with LEGAL optimisation)
 */
import { BIP39 } from "./bip39.js";

export const PROFILES = [
  { name: "crypto-secrets", guardrail_name: "taxpilot_secret_scanner" },
  { name: "prompt-injection", guardrail_name: "taxpilot_injection_heuristics" },
  { name: "tax-evasion", guardrail_name: "taxpilot_evasion_policy" },
] as const;

export interface Verdict { valid: boolean; explanation: string | null; score: number }

/** Longest run of consecutive BIP-39 words (a 12/24-word seed phrase gives >= 12). */
export function longestBip39Run(text: string): number {
  const toks = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let best = 0, cur = 0;
  for (const t of toks) { if (BIP39.has(t)) { cur++; best = Math.max(best, cur); } else cur = 0; }
  return best;
}

export function checkSecrets(text: string): Verdict {
  const run = longestBip39Run(text);
  if (run >= 12) return { valid: false, explanation: `Looks like a wallet seed phrase (${run} consecutive BIP-39 words). Never share it: TaxPilot only needs public addresses.`, score: 0.99 };
  // a raw private key: 64 hex chars standing alone, or labelled as a key (tx hashes are 0x-prefixed and not labelled)
  if (/(private\s*key|priv\s*key|secret\s*key|pk)\s*[:=]?\s*(0x)?[a-f0-9]{64}\b/i.test(text) || /(^|[^0-9a-fx])[a-f0-9]{64}([^0-9a-f]|$)/i.test(text))
    return { valid: false, explanation: "Looks like a private key. Never share it: TaxPilot only needs public addresses.", score: 0.97 };
  if (/\b(xprv|yprv|zprv|tprv)[1-9A-HJ-NP-Za-km-z]{100,}/.test(text))
    return { valid: false, explanation: "Looks like an extended private key (xprv).", score: 0.98 };
  return { valid: true, explanation: null, score: 0.01 };
}

const INJECTION: [RegExp, number][] = [
  [/ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i, 0.97],
  [/disregard (your|the|all) (instructions|rules|system prompt)/i, 0.95],
  [/(reveal|print|show|repeat|leak) (me )?(your|the) (system prompt|instructions|hidden prompt)/i, 0.95],
  [/you are (now|no longer) /i, 0.8],
  [/\b(jailbreak|DAN mode|developer mode)\b/i, 0.9],
  [/(call|use|run) (the )?(code[_ ]execution|web[_ ]fetch|mcp) (tool )?to (send|post|exfiltrate|upload)/i, 0.9],
  [/(api[_ ]?key|otk_|bearer token|environment variables?|process\.env)/i, 0.85],
];

export function checkInjection(text: string): Verdict {
  for (const [re, score] of INJECTION) if (re.test(text)) return { valid: false, explanation: `Prompt-injection pattern: ${re.source.slice(0, 60)}`, score };
  return { valid: true, explanation: null, score: 0.02 };
}

const EVASION: RegExp[] = [
  /\b(hide|conceal|hiding)\b.{0,40}\bfrom (the )?(tax|irs|hmrc|dgfip|finanzamt|fisc|government|authorit)/i,
  /\b(not|never|avoid|without)\b (declare|declaring|report|reporting|file|filing)\b.{0,30}\b(crypto|gains?|income|profits?|foreign accounts?|binance|wallets?)/i,
  /(evade|evading|evasion of) (the )?tax/i,
  /(fake|forge|backdate|falsif\w*) (the )?(receipts?|invoices?|cost basis|purchase|dates?|records?)/i,
  /(launder|mixer|tornado cash).*(tax|irs|clean)/i,
  /(cacher|dissimuler) .*(fisc|imp[oô]ts?|administration)/i,
  /(ne pas|sans) d[ée]clarer/i,
];

export function checkEvasion(text: string): Verdict {
  for (const re of EVASION) if (re.test(text)) return { valid: false, explanation: "Request to hide income or falsify records: TaxPilot only helps with legal optimisation.", score: 0.9 };
  return { valid: true, explanation: null, score: 0.03 };
}

export function validate(profile: string, text: string): Verdict | null {
  if (profile === "crypto-secrets") return checkSecrets(text);
  if (profile === "prompt-injection") return checkInjection(text);
  if (profile === "tax-evasion") return checkEvasion(text);
  return null;
}
