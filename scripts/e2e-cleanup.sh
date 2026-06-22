#!/usr/bin/env bash
#
# scripts/e2e-cleanup.sh — tear down a knext deployment for the official Next.js
# compatibility harness (#89, ADR-0007 A3-2). SEPARATE process from e2e-deploy.sh;
# reads the server PID/PORT from .adapter-build.log and stops it.
#
# Sends SIGTERM first (node-server / standalone drains in-flight requests + runs
# after() callbacks — the graceful-shutdown security rule), then SIGKILL fallback.
set -uo pipefail

APP_DIR="$(pwd)"
LOG_FILE="${APP_DIR}/.adapter-build.log"

if [ ! -f "${LOG_FILE}" ]; then
  echo "[e2e-cleanup] no .adapter-build.log — nothing to clean up" >&2
  exit 0
fi

PID="$(grep -E '^PID=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"
PORT="$(grep -E '^PORT=' "${LOG_FILE}" | head -n1 | cut -d= -f2- || true)"

echo "[e2e-cleanup] stopping deployment pid=${PID:-?} port=${PORT:-?}" >&2

if [ -n "${PID:-}" ] && kill -0 "${PID}" 2>/dev/null; then
  # graceful drain first
  kill -TERM "${PID}" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "${PID}" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  # hard kill if still alive
  if kill -0 "${PID}" 2>/dev/null; then
    echo "[e2e-cleanup] SIGTERM timed out; sending SIGKILL to ${PID}" >&2
    kill -KILL "${PID}" 2>/dev/null || true
  fi
fi

# best-effort: clear the log so a re-run starts clean
rm -f "${LOG_FILE}" 2>/dev/null || true

echo "[e2e-cleanup] done" >&2
exit 0
