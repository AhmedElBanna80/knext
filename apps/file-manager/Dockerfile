# OpenNext Production Dockerfile
# Uses pre-built .open-next output (built by kn-next CLI)
# Build from repo root: docker build -f apps/file-manager/Dockerfile .

FROM --platform=linux/amd64 node:24-alpine AS runner

ENV NODE_ENV=production
ENV PORT=3000

# Install su-exec for dropping privileges in entrypoint
RUN apk add --no-cache su-exec

# Create bytecode cache directory (used when NODE_COMPILE_CACHE is set)
RUN mkdir -p /cache/bytecode && chown node:node /cache/bytecode

# Copy pre-built OpenNext server bundle (built by CLI, not Docker)
# OpenNext pnpm monorepo layout: server-functions/default/ preserves
# the monorepo structure (apps/{name}/, node_modules/)
COPY apps/file-manager/.open-next/server-functions/default /app

# Set working directory to the app's location within the monorepo layout
WORKDIR /app/apps/file-manager

# Install ioredis for the Next.js cache handler (not traced by standalone output)
RUN npm install --no-save ioredis 2>/dev/null || true

# Copy entrypoint script
COPY apps/file-manager/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

# Run as root initially, entrypoint drops to node user after fixing PVC permissions
ENTRYPOINT ["/entrypoint.sh"]
