#!/bin/sh
# Entrypoint script: fix PVC permissions, then run as node user
# The PVC is mounted as root-owned, but V8 compile cache needs write access
if [ -d "/cache/bytecode" ]; then
  chown -R node:node /cache/bytecode 2>/dev/null || true
  mkdir -p "$NODE_COMPILE_CACHE" 2>/dev/null || true
  chown -R node:node "$NODE_COMPILE_CACHE" 2>/dev/null || true
fi

# Override HOSTNAME — Kubernetes sets it to the pod name (e.g. file-manager-00001-...-bqrct),
# which causes Next.js to bind on that hostname instead of all interfaces.
# This makes queue-proxy health checks on 127.0.0.1:3000 fail with "connection refused".
export HOSTNAME=0.0.0.0

# Fix Next.js cache directory permissions — the .next dir is root-owned from the
# Docker build, but Next.js 16 needs write access for prerender cache (.next/cache)
# and segment files (.next/server/app/*.segments). Without this fix, cache writes
# fail with EACCES and OpenNext cache adapters never fire.
NEXT_DIR="$(pwd)/.next"
if [ -d "$NEXT_DIR" ]; then
  mkdir -p "$NEXT_DIR/cache" 2>/dev/null || true
  chown -R node:node "$NEXT_DIR/cache" 2>/dev/null || true
  chown -R node:node "$NEXT_DIR/server" 2>/dev/null || true
  echo "[kn-next] Fixed .next cache permissions"
fi

# Drop to node user and exec the Next.js standalone server
exec su-exec node node server.js
