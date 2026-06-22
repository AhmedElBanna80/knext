#!/usr/bin/env bash
#
# scripts/e2e-logs.sh — print the knext deployment logs for the official Next.js
# compatibility harness (#89, ADR-0007 A3-2). The harness calls this (cwd = the
# fixture app dir) when a test fails, to capture diagnostics. It is a SEPARATE
# process from e2e-deploy.sh and shares state only via .adapter-build.log.
#
# Prints: the deployment metadata (.adapter-build.log) + the captured server
# stdout/stderr (.adapter-server.log).
set -uo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"
SERVER_LOG="${APP_DIR}/.adapter-server.log"

echo "==== knext deployment metadata (.adapter-build.log) ===="
if [ -f "${LOG_FILE}" ]; then
  cat "${LOG_FILE}"
else
  echo "(no .adapter-build.log — deploy may not have run)"
fi

echo ""
echo "==== knext standalone server log (.adapter-server.log) ===="
# Prefer the SERVER_LOG path recorded in the metadata, else the default location.
RECORDED_SERVER_LOG="$(grep -E '^SERVER_LOG=' "${LOG_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- || true)"
SERVER_LOG="${RECORDED_SERVER_LOG:-${SERVER_LOG}}"
if [ -f "${SERVER_LOG}" ]; then
  cat "${SERVER_LOG}"
else
  echo "(no server log at ${SERVER_LOG})"
fi
