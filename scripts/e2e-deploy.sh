#!/usr/bin/env bash
#
# scripts/e2e-deploy.sh — knext deploy-script for the official Next.js compatibility
# harness (#89, ADR-0007 A3-2). The harness (run-tests.js, NEXT_TEST_MODE=deploy)
# invokes THIS script once per fixture app with cwd = the app's temp dir, and reads
# EXACTLY ONE stdout line — the deployment URL — to drive its e2e tests against a
# real, running knext deployment.
#
# Contract (mirrors the reference adapter-bun e2e-deploy.sh, adapted to knext's
# output:'standalone' runtime):
#   1. (unless KNEXT_E2E_SKIP_PACK=1) npm pack @knext/core, install the tarball into
#      the temp app, so NEXT_ADAPTER_PATH resolves the package-shipped adapter.
#   2. NEXT_ADAPTER_PATH = the knext adapter; run `next build` (output:'standalone').
#   3. Stage .next/static + public/ into the standalone tree (standalone does NOT copy
#      them — same as the Dockerfile / compat-smoke.mjs).
#   4. Boot the standalone server.js on a FREE port, on KNEXT_RUNTIME (node|bun).
#   5. TCP-probe readiness.
#   6. Persist BUILD_ID / DEPLOYMENT_ID / PORT / PID to .adapter-build.log so the
#      SEPARATE logs + cleanup processes can find the deployment.
#   7. Echo http://localhost:<port> as the ONLY stdout line; non-zero exit on failure.
#
# All diagnostics go to STDERR — stdout is reserved for the single URL line.
set -euo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"
RUNTIME="${KNEXT_RUNTIME:-node}"   # node (default) | bun  (bun = fast-follow target)

log() { echo "[e2e-deploy] $*" >&2; }

# ── pick a free TCP port ──────────────────────────────────────────────────────
free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,()=>{const p=s.address().port;s.close(()=>console.log(p));});'
}

# ── 1. pack + install the knext adapter tarball (skippable for the contract test) ─
ADAPTER_PKG_DIR="${ADAPTER_DIR:-}"
if [ "${KNEXT_E2E_SKIP_PACK:-0}" != "1" ]; then
  if [ -z "${ADAPTER_PKG_DIR}" ]; then
    log "ERROR: ADAPTER_DIR must point at the @knext/core package dir (or set KNEXT_E2E_SKIP_PACK=1)"
    exit 1
  fi
  log "packing @knext/core from ${ADAPTER_PKG_DIR}"
  TARBALL="$(cd "${ADAPTER_PKG_DIR}" && npm pack --silent | tail -n1)"
  TARBALL_PATH="${ADAPTER_PKG_DIR}/${TARBALL}"
  log "installing adapter tarball ${TARBALL_PATH} into ${APP_DIR}"
  npm install --no-save "${TARBALL_PATH}" >&2
  # Resolve the installed adapter entry (package export "./adapter").
  NEXT_ADAPTER_PATH="$(node -e 'process.stdout.write(require.resolve("@knext/core/adapter"))')"
else
  log "KNEXT_E2E_SKIP_PACK=1 — skipping npm pack/install (contract-test mode)"
  NEXT_ADAPTER_PATH="${NEXT_ADAPTER_PATH:-}"
fi
export NEXT_ADAPTER_PATH
log "NEXT_ADAPTER_PATH=${NEXT_ADAPTER_PATH:-<unset>}"

# ── 2. build the fixture app through the knext adapter ────────────────────────
log "running next build (output:'standalone')"
next build >&2

# ── 3. locate + stage the standalone server tree ──────────────────────────────
# output:'standalone' emits server.js under .next/standalone (monorepo fixtures may
# nest it under .next/standalone/<app-path>/server.js); find the first one.
SERVER_JS="$(find "${APP_DIR}/.next/standalone" -maxdepth 4 -name server.js 2>/dev/null | head -n1 || true)"
if [ -z "${SERVER_JS}" ]; then
  log "ERROR: standalone server.js not found under .next/standalone"
  exit 1
fi
STANDALONE_APP_DIR="$(dirname "${SERVER_JS}")"
log "standalone server: ${SERVER_JS}"

# standalone does not copy .next/static or public/ — stage them (best-effort).
if [ -d "${APP_DIR}/.next/static" ]; then
  mkdir -p "${STANDALONE_APP_DIR}/.next"
  cp -R "${APP_DIR}/.next/static" "${STANDALONE_APP_DIR}/.next/static"
fi
if [ -d "${APP_DIR}/public" ]; then
  cp -R "${APP_DIR}/public" "${STANDALONE_APP_DIR}/public"
fi

# ── 4. boot the standalone server on a free port ──────────────────────────────
PORT="$(free_port)"
BUILD_ID="$(cat "${APP_DIR}/.next/BUILD_ID" 2>/dev/null || echo "unknown")"
# DEPLOYMENT_ID identifies this deployment to the harness (asset versioning / skew).
DEPLOYMENT_ID="${NEXT_DEPLOYMENT_ID:-knext-${BUILD_ID}-$(date +%s)}"

case "${RUNTIME}" in
  bun) SERVER_CMD="bun" ;;
  *)   SERVER_CMD="node" ;;
esac

log "booting (${RUNTIME}) ${SERVER_JS} on 127.0.0.1:${PORT}"
(
  cd "${STANDALONE_APP_DIR}"
  PORT="${PORT}" HOSTNAME="127.0.0.1" NODE_ENV="production" \
    NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" \
    exec "${SERVER_CMD}" "${SERVER_JS}"
) >"${SERVER_LOG}" 2>&1 &
SERVER_PID=$!

# ── 5. persist deployment metadata BEFORE probing (so cleanup can always find it) ─
{
  echo "BUILD_ID=${BUILD_ID}"
  echo "DEPLOYMENT_ID=${DEPLOYMENT_ID}"
  echo "PORT=${PORT}"
  echo "PID=${SERVER_PID}"
  echo "RUNTIME=${RUNTIME}"
  echo "SERVER_JS=${SERVER_JS}"
  echo "SERVER_LOG=${SERVER_LOG}"
} >"${LOG_FILE}"

# ── 6. TCP-probe readiness ────────────────────────────────────────────────────
READY=0
for _ in $(seq 1 100); do
  if node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null; then
    READY=1
    break
  fi
  # bail early if the server process already died
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    log "ERROR: server process ${SERVER_PID} exited before becoming ready"
    log "---- server log ----"
    cat "${SERVER_LOG}" >&2 || true
    exit 1
  fi
  sleep 0.3
done

if [ "${READY}" != "1" ]; then
  log "ERROR: server never became ready on port ${PORT}"
  cat "${SERVER_LOG}" >&2 || true
  exit 1
fi

log "deployment ready: build=${BUILD_ID} deployment=${DEPLOYMENT_ID} pid=${SERVER_PID}"

# ── 7. the ONLY stdout line: the deployment URL ───────────────────────────────
echo "http://localhost:${PORT}"
