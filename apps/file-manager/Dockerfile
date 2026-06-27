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

# Build a clean, flat, production-only sharp install for THIS platform (musl) that
# the runner stage can copy verbatim into the app's node_modules. We do NOT rely on
# Next's standalone trace to carry sharp: Next's image optimizer require()s sharp
# lazily at runtime, and with pnpm's symlinked store the node-file-trace step does
# not reliably include sharp + its @img/sharp-* native platform packages — that is
# exactly why `require('sharp')` failed in the runner before (#66). The builder is
# already node:22-alpine (linux/musl), so `npm install` here resolves the correct
# @img/sharp-linuxmusl-* prebuilt + bundled libvips for the runner's musl arch.
# Pin to the same major as apps/file-manager/package.json ("sharp": "^0.35.2").
RUN mkdir -p /sharp-runtime \
    && cd /sharp-runtime \
    && npm init -y >/dev/null 2>&1 \
    && npm install --no-audit --no-fund --omit=dev sharp@^0.35.2 \
    && node -e "const s=require('/sharp-runtime/node_modules/sharp');console.log('builder sharp ok: libvips '+s.versions.vips)"

# Stage 2: Lean production image using Node.js standalone output
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install curl for healthcheck. sharp 0.35's musl prebuilt (@img/sharp-linuxmusl-*)
# bundles its own libvips, so the `vips` apk package is NOT strictly required; we keep
# it as a defensive fallback for any code path that prefers a global libvips. (#66 AC#3.)
RUN apk add --no-cache curl vips

# node:22-alpine already ships a non-root `node` user/group at uid/gid 1000;
# recreating it fails ("group 'node' in use"). Reuse the existing user.

# Copy standalone server bundle (includes node_modules trace)
COPY --from=builder /app/apps/file-manager/.next/standalone ./
# Copy static assets served locally (non-CDN fallback)
COPY --from=builder /app/apps/file-manager/.next/static ./apps/file-manager/.next/static
# Copy public assets
COPY --from=builder /app/apps/file-manager/public ./apps/file-manager/public

# Place the flat musl sharp install — sharp itself, its @img native platform
# packages, AND sharp's own runtime deps (detect-libc, semver, color, …) — into the
# app's node_modules so `require('sharp')` (resolved from server.js) finds it. This is
# the fix for #66: the standalone trace alone does not carry sharp's native runtime.
# We copy the WHOLE flat tree (not just sharp + @img) because sharp require()s
# detect-libc at load time, which is a sibling in the flat install; copying only
# sharp/@img leaves it with "Cannot find module 'detect-libc'". COPY merges into the
# existing traced node_modules without clobbering the app's own modules.
COPY --from=builder /sharp-runtime/node_modules/ ./apps/file-manager/node_modules/

# Verify sharp's native (musl) runtime actually loads in THIS image — fail the
# build now rather than 500ing at request time on /_next/image. The standalone
# trace places sharp under the app's node_modules; resolve from there. (#66 AC#3.)
RUN node -e "const{createRequire}=require('module');const r=createRequire('/app/apps/file-manager/server.js');const s=r('sharp');console.log('sharp ok: libvips '+s.versions.vips)" \
    || (echo 'FATAL: sharp failed to load — next/image optimization is broken in this image (missing libvips/musl runtime?)' && exit 1)

# Pre-create the compile-cache directory
RUN mkdir -p apps/file-manager/.next/compile-cache && chown -R node:node apps/file-manager/.next

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:3000/api/health || exit 1

# Drop privileges
USER node

# NODE_COMPILE_CACHE: V8 bytecode cache for faster subsequent cold starts.
# EXPORT so the value reaches the exec'd node process (a bare `${VAR:=default}` only sets a shell
# variable, not an env var). The operator's externally-injected value (PVC path) still wins via
# `:-`; the Dockerfile only supplies the fallback when the env var is unset at runtime.
CMD ["sh", "-c", "export NODE_COMPILE_CACHE=\"${NODE_COMPILE_CACHE:-apps/file-manager/.next/compile-cache}\"; exec node apps/file-manager/server.js"]
