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

# Fix Nitro/Vinext cache permissions if needed
# We don't have .next anymore, but just in case any specific folders need writes
if [ -d ".output" ]; then
  chown -R node:node .output 2>/dev/null || true
fi

# Drop to node user and exec the Nitro standalone server
exec su-exec node node .output/server/index.mjs
