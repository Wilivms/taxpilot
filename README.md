# TaxPilot — crypto tax agent on BNB Chain

Give it a country and BSC wallets: it reads the real onchain history, applies the tax law in force (24 countries, each with its official source), fills the matching tax form (FR 2086/2042-C/3916-bis, DE Anlage SO, UK SA108, US Form 8949…), proposes legal optimisation strategies and compares residencies for nomads / multiple nationalities.

- `agent/` — BNB Agent Studio project (ERC-8004 identity, ERC-8183 paid jobs). Put your Alchemy key in `agent/app/agent/src/localKeys.ts` or the `ALCHEMY_API_KEY` env var.
- `web/` — Vercel site (static front + `api/report` serverless function). Needs `ALCHEMY_API_KEY`.

Not tax advice: verify with an accountant before filing.
