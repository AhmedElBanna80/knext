# Stage 1: Build Next.js app with standalone output
FROM node:22-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install -g pnpm
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# Build the workspace lib (@knext/lib ships only dist/) BEFORE the app, in a
# SEPARATE step so its dist/ is fully emitted before `next build` resolves it.
# (A combined recursive build can race the app's build ahead of the lib's emit.)
RUN pnpm --filter "@knext/lib" build
# @knext/core also ships only dist/ and its exports resolve to ./dist/* (#114);
# file-manager imports @knext/core (adapter + KnativeNextConfig), so core must be
# built (after lib, whose types core's build needs) BEFORE `next build` resolves
# it from dist. Order: lib → core → file-manager.
RUN pnpm --filter "@knext/core" build
RUN pnpm --filter file-manager build

# Stage 2: Lean production image using Node.js standalone output
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck
RUN apk add --no-cache curl

# node:22-alpine already ships a non-root `node` user/group at uid/gid 1000;
# recreating it fails ("group 'node' in use"). Reuse the existing user.

# Copy standalone server bundle (includes node_modules trace)
COPY --from=builder /app/apps/file-manager/.next/standalone ./
# Copy static assets served locally (non-CDN fallback)
COPY --from=builder /app/apps/file-manager/.next/static ./apps/file-manager/.next/static
# Copy public assets
COPY --from=builder /app/apps/file-manager/public ./apps/file-manager/public

# Pre-create the compile-cache directory
RUN mkdir -p apps/file-manager/.next/compile-cache && chown -R node:node apps/file-manager/.next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Drop privileges
USER node

# Runtime entry: boot the knext runtime (@knext/core node-server), NOT bare
# `node server.js`. The runtime entry is the ONLY thing that (1) installs the
# SIGTERM handler that forwards the signal so Next drains in-flight requests +
# runs `after()` callbacks on scale-down (security.md graceful shutdown), and
# (2) serves the Prometheus metrics sidecar on :9091. Bare-exec'ing server.js
# bypasses both, so a real knext deploy must run the runtime entry — matching
# how the operator-managed image runs. The entry then SPAWNS server.js itself.
#
# @knext/core is traced into the standalone bundle's node_modules, so the
# package specifier resolves via its `exports` map (./internal/node-server).
# The container layout puts server.js at apps/file-manager/server.js, so we tell
# the runtime entry where it is via STANDALONE_SERVER_PATH (its default,
# .next/standalone/server.js, is the single-app layout).
#
# NODE_COMPILE_CACHE: V8 bytecode cache for faster subsequent cold starts.
# EXPORT so the value reaches the exec'd node process (a bare `${VAR:=default}` only sets a shell
# variable, not an env var). The operator's externally-injected value (PVC path) still wins via
# `:-`; the Dockerfile only supplies the fallback when the env var is unset at runtime.
CMD ["sh", "-c", "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE:-apps/file-manager/.next/compile-cache}\"; export STANDALONE_SERVER_PATH=\"${STANDALONE_SERVER_PATH:-apps/file-manager/server.js}\"; exec node -e \"import('@knext/core/internal/node-server')\""]
