# Minimal Next.js standalone image for the scale-to-zero demo.
# Same packaging shape a real knext NextApp uses: `next build` with
# output:'standalone' -> a self-contained server.js on a slim Node base.
# Built --platform linux/amd64 (OKE nodes are amd64).

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS builder
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85 AS runner
WORKDIR /app
ENV NODE_ENV=production
# Operator hardcodes containerPort 3000; standalone server honours PORT/HOSTNAME.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3000
USER 1000:1000
CMD ["node", "server.js"]
