#!/usr/bin/env bash
# Bundles the agent's tax engine into the Vercel function (key-free: the key comes from ALCHEMY_API_KEY).
set -euo pipefail
cd "$(dirname "$0")/.."
npx --yes esbuild web/api-src/report.ts --bundle --minify --platform=node --format=esm --outfile=web/api/report.mjs
