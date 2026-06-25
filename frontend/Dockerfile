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

# Build-only DATABASE_URL placeholder. `next build` imports every API
# route to collect page data, and `lib/db/client.ts` eagerly creates the
# pg pool at module load (throwing if no connection string is set). The
# build never issues queries, so the value just needs to satisfy the
# eager check. Point at localhost:1 so it fails closed if it ever leaks.
# The real DATABASE_URL is composed at runtime from the RDS-managed
# secret injected by the ECS task definition.
ENV DATABASE_URL=postgresql://build:build@localhost:1/build_placeholder

# Next.js standalone output + the bundled migration runner. Both end up
# under dist/ — `next build` writes .next/standalone, the migrate script
# writes dist/migrate/migrate.js.
RUN npm run build && npm run build:migrate

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

# Migration runner: single-file CJS bundle + raw migration SQL files.
# The entrypoint runs the bundle before exec'ing the Next.js server,
# so the DB schema is current before the first request lands.
COPY --from=build --chown=nextjs:nodejs /app/dist/migrate/migrate.js ./migrate.js
COPY --from=build --chown=nextjs:nodejs /app/lib/db/migrations ./lib/db/migrations
COPY --chown=nextjs:nodejs entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

# RDS Global CA bundle. Needed by the runtime DB pool when RDS IAM auth
# is enabled (DANTE_USE_IAM_DB_AUTH=1) — IAM tokens require SSL and we
# want verify-full chain validation, not the "encrypt-but-don't-verify"
# fallback the static-password path used to settle for. AWS publishes
# a single global bundle that includes regional intermediates; updated
# periodically as new CAs are added. Fetching at build time pins it to
# the image SHA. Same path used by lib/db/_rds-iam.ts and lib/sync/db.ts.
RUN wget -q -O /app/rds-global-bundle.pem \
      https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && chown nextjs:nodejs /app/rds-global-bundle.pem

USER nextjs
EXPOSE 3000

# The ECS task definition has its own healthcheck — defining one in the
# image too keeps `docker run` developer ergonomics intact.
# Generous timeouts because Next.js 16's standalone server logs "Ready"
# before it finishes JIT-compiling route handlers; the first request to
# /api/auth/csrf (which loads Auth.js) can take 5-10s on a cold start.
HEALTHCHECK --interval=30s --timeout=15s --start-period=90s --retries=5 \
  CMD wget -q -O- -T 10 http://localhost:3000/api/auth/csrf || exit 1

ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "server.js"]
