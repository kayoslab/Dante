# syntax=docker/dockerfile:1.7
# Multi-stage build for the Next.js app.
#
# Stages:
#   1. deps   — install full node_modules (incl. devDeps; needed for build).
#   2. build  — `next build` produces `.next/standalone/` + `.next/static/`.
#   3. runner — copy only the standalone bundle + static + public assets.
#              Runs as a non-root user on Node 22 arm64.
#
# Target arm64 to match the ECS Fargate task arch (cheaper than x86_64
# at the same RAM/CPU and good enough for Next.js workloads).
#
# Build with:
#   docker buildx build --platform linux/arm64 -t <ecr_url>:<sha> --load .
# Push with:
#   docker push <ecr_url>:<sha>

ARG NODE_VERSION=22-alpine

# --- deps ---------------------------------------------------------------

FROM --platform=linux/arm64 node:${NODE_VERSION} AS deps
WORKDIR /app

# Copy only manifests so changes to source don't bust the npm-install cache.
COPY package.json package-lock.json ./
# Use a BuildKit cache mount so repeat builds reuse the npm cache.
RUN --mount=type=cache,target=/root/.npm \
    npm ci --include=dev

# --- build --------------------------------------------------------------

FROM --platform=linux/arm64 node:${NODE_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Skip telemetry; build for production.
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# --- runner -------------------------------------------------------------

FROM --platform=linux/arm64 node:${NODE_VERSION} AS runner
WORKDIR /app

# wget is in alpine-base — used by the ECS task definition's container
# health check (`wget -q -O- http://localhost:3000/api/auth/csrf`).

# Non-root user to limit blast radius if the app process is compromised.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 --ingroup nodejs nextjs

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output bundles the runtime entrypoint at `server.js` and
# brings minimal node_modules; static assets live in `public/` and
# `.next/static/`.
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/public ./public

# Migrations bundled so an entrypoint can run them at boot if desired.
COPY --from=build --chown=nextjs:nodejs /app/lib/db/migrations ./lib/db/migrations

USER nextjs
EXPOSE 3000

# The ECS task definition has its own healthcheck — defining one in the
# image too keeps `docker run` developer ergonomics intact.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/auth/csrf || exit 1

CMD ["node", "server.js"]
