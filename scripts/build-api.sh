#!/usr/bin/env bash
# Bundles the agent's tax engine + the Otari copilot into Vercel functions (secrets come from env vars).
set -euo pipefail
cd "$(dirname "$0")/.."
for f in report copilot mcp guard budget; do
  npx --yes esbuild "web/api-src/$f.ts" --bundle --minify --platform=node --format=esm --outfile="web/api/$f.mjs" --log-level=warning
done
