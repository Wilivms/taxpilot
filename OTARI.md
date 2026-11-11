# TaxPilot × Otari: how the integration works

TaxPilot started as a BNB Chain hackathon project. It is a deterministic crypto tax engine for 24 countries that fills the official forms and computes legal optimisation strategies. For **Mozilla Devs Wilding**, we finished it with an **AI copilot that runs entirely through [Otari](https://otari.ai)** (hosted, EU region). The tax math stays in code; Otari orchestrates five open-weight models around that code to **guard**, **verify the law**, **audit the numbers** and **explain** them.

- Branch: `otari-devs-wilding`. Otari first appears in commit `ae1d784`.
- Live: the **02 / AI Copilot** section of the site. Every Otari feature lights up in the UI only when the gateway's own response proves it ran.

```
question ──► [0] per-user budget preflight ─────────────── GET /end-users (service key)
         ──► [1] Otari guardrails (block) ──► Llama Guard 4 12B ── our guardrails service /api/guard
         ──► [2] law-as-code engine (TypeScript, no model)
         ──► [3] taxpilot-research  ── DeepSeek V4 Flash ⇢ Qwen3 235B ⇢ Mistral Small 4   + otari_web_search / otari_web_fetch
         ──► [4] taxpilot-auditor   ── gpt-oss-120b (DeepInfra ⇢ Together ⇢ Fireworks) ⇢ Qwen3 Coder  + TaxPilot MCP server + otari_code_execution
             [4b] POST /code/execute ── model-free sandbox replay of the ledger
         ──► [5] taxpilot-writer    ── Gemma 3 27B (⇢ Gemma 3 12B above 70 % budget) ⇢ Ministral 8B   + guardrail (monitor)
```
Steps 3 and 4 run in parallel, and the result streams to the browser step by step as NDJSON.

## Rubric map: where each feature lives in the code

| Rubric item | What TaxPilot does | Code |
|---|---|---|
| **Open-weight models (≥2, different purposes)** | Llama Guard 4 12B (safety classifier), DeepSeek V4 Flash (law research), gpt-oss-120b (math audit, tool use), Gemma 3 27B/12B (writing). Fallbacks: Qwen3 235B, Qwen3 Coder 30B, Mistral Small 4, Ministral 8B. All are open-weight models served through Otari. | `web/api-src/copilotCore.ts` (`MODELS`) |
| **Model routing and fallbacks** | Four Otari routing policies: `taxpilot-research`, `taxpilot-auditor`, `taxpilot-writer`, plus `taxpilot-outage-drill` (UI toggle "Outage drill"). In the drill, the first target (Llama Guard 4) refuses structured output with a 400, and Otari fails over to Gemma 3 27B live (`Otari-Fallback: true`, attempt 2). They fail over across models and across providers (gpt-oss-120b on DeepInfra, then Together, then Fireworks). The writer policy uses a `budget_used_pct ≥ 70` condition to tier down to Gemma 3 12B. The app reads `Otari-Model`, `Otari-Provider`, `Otari-Fallback` and `Otari-Attempt-Count` and shows them. | `copilotCore.ts`, `otari.ts` (`chat`) |
| **MCP integrations** | We wrote an **MCP server** that exposes the deterministic engine (`get_tax_report`, `get_disposal_ledger`, `get_tax_rules`, `compare_residencies`). It is stored in the Otari workspace, and the auditor calls it through `mcp_server_ids`, so Otari runs the MCP tool loop. | `web/api-src/mcpServer.ts`, `web/api-src/mcp.ts` |
| **Web search / web fetch** | The research step checks every rule the engine applies (rates, allowances, holding periods) against today's sources with `otari_web_search` + `otari_web_fetch`, and returns confirmed / different / unclear with source URLs. | `copilotCore.ts` → `research()` |
| **Code execution** | The auditor model re-derives the totals in Otari's sandbox (`otari_code_execution`), with one corrective retry if it skipped the sandbox. In addition, a **model-free** `POST /code/execute` replays the ledger, so the numbers are checked even if the model misbehaves. | `copilotCore.ts` → `audit()`, `otari.ts` (`execute`) |
| **Budgets and spending limits** | A workspace spend ceiling (monthly) and `max_tokens` per role. The search step is capped with `max_uses`. A budget preflight switches to **saver mode** (research and model audit skipped) at ≥ 85 % of the user's budget. Any Otari `403 budget_exceeded` falls back to the deterministic summary, so the free report never breaks. | `copilotCore.ts` |
| **Multiple models serving distinct roles** | guardian → researcher → auditor → advisor, each a different open-weight family picked for its job. | `copilotCore.ts` |
| **Guardrails** | We wrote a **guardrails service** that speaks Otari's `/validate` contract, with three crypto-tax profiles: `crypto-secrets` (BIP-39 seed phrases, private keys and xprv keys never reach a provider), `prompt-injection`, and `tax-evasion` (we only help with *legal* optimisation). Otari runs these profiles in **block** mode before any provider is called (403 `guardrail_violation`). The advisor call carries a `monitor` check whose verdict comes back in the `Otari-Guardrails` header. | `web/api-src/guardService.ts`, `web/api-src/guard.ts` |
| **Per-user budgets** | An Otari **service key**: each browser is an end user (`user: "tp:<id>"`) on the `taxpilot-end-user-daily` budget ($0.12/day, 60 requests). A `taxpilot-end-user-pro` tier also exists. The UI shows the live spend meter from `GET /end-users`. | `otari.ts` (`endUser`), `web/api-src/budget.ts` |

## Otari configuration (done through the Otari API)

- Service key `taxpilot-service`: `is_service_key`, end-user budgets `taxpilot-end-user-daily` (default) and `taxpilot-end-user-pro`.
- Workspace spend ceiling: `taxpilot-workspace-monthly` ($1.50/month).
- Routing policies: `taxpilot-research`, `taxpilot-auditor`, `taxpilot-writer`, `taxpilot-outage-drill`.
- Workspace tools: web search on (max 3 results, purpose hint "official government sources"), code execution on (30 s, 4 iterations).
- Stored MCP server `taxpilot` → `/api/mcp` (bearer token).
- Request-level guardrails → `/api/guard` (bearer credential).

## Issues we opened on Otari

- [#3150](https://github.com/mozilla-ai/otari/issues/3150): routing policies reject catalog model ids that chat completions accept.
- [#3151](https://github.com/mozilla-ai/otari/issues/3151): let a request require a gateway tool (`tool_choice` for `otari_code_execution`).

## Run it

```bash
# env: OTARI_API_KEY (service key), OTARI_BASE_URL=https://eu.api.otari.ai/api/v1, GUARD_TOKEN, MCP_TOKEN
bash scripts/build-api.sh                 # bundles web/api-src/*.ts into Vercel functions
npx tsx --test web/test/core.test.ts      # guardrails, MCP server, ledger consistency (offline)
```
