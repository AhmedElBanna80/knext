# file-manager — official Next.js Adapter + output:'standalone', run on Node.
# Cold-start bytecode caching is provided at runtime via NODE_COMPILE_CACHE
# (the kn-next-operator injects NODE_COMPILE_CACHE=/cache/bytecode/latest and
# mounts the bytecode-cache PVC). No bun --compile, no NFT embedding.
# Build context = repo root:  docker build -f apps/file-manager/Dockerfile .

# ── Stage 1: build the standalone server ──────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile
# Build the workspace lib first (its exports map to dist/) so `next build`
# can trace it into the standalone output, then build the app.
RUN pnpm --filter "@knative-next/lib" build
RUN pnpm --filter file-manager build   # next build --webpack -> .next/standalone

# ── Stage 2: distroless Node runtime ──────────────────────────────────────
FROM gcr.io/distroless/nodejs22-debian12 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    # Default V8 compile-cache dir; the operator overrides this with the
    # PVC-backed /cache/bytecode/latest for cross-cold-start reuse.
    NODE_COMPILE_CACHE=/tmp/v8-compile-cache

# Standalone server + its traced node_modules/workspace packages.
COPY --from=builder /app/apps/file-manager/.next/standalone ./
# Static assets + public are NOT included in standalone — place them where
# the standalone server expects them.
COPY --from=builder /app/apps/file-manager/.next/static ./apps/file-manager/.next/static
COPY --from=builder /app/apps/file-manager/public ./apps/file-manager/public

EXPOSE 3000

# distroless nodejs ENTRYPOINT is ["/usr/bin/node"]; pass the server entry.
# Readiness/liveness is handled by the Knative probes the operator injects.
CMD ["apps/file-manager/server.js"]
