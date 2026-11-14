#!/usr/bin/env bash
set -euo pipefail
npm i -g bun@1.4.2 >/dev/null 2>&1
echo "bun $(bun --version)"
for cell in node-turbopack node-webpack bun-turbopack bun-webpack; do
  echo "=== CELL $cell"
  cd /workspace/bc13-$cell
  npm install --no-audit --no-fund 2>&1 | tail -2
  node -e 'console.log("core", require("./node_modules/@getknext/core/package.json").version, "lib", require("./node_modules/@getknext/lib/package.json").version, "next", require("./node_modules/next/package.json").version)'
  grep -nE '^  (name|runtime|build):' knext.config.ts || true
  grep '"build"' package.json
  npx knext build 2>&1 | tail -15
  T=node_modules/@getknext/core/templates/runtime-standalone
  cp $T/Dockerfile.standalone.hbs Dockerfile.standalone
  for f in knext-standalone-entry.mjs knext-compile-cache-bake.mjs knext-self-contained-server-shim.js; do cp $T/$f.hbs $f; done
done
