#!/bin/sh
# Container entrypoint.
#
# Runs DB migrations first (idempotent, advisory-locked by drizzle) and
# only then exec's the Next.js server. A migration failure exits the
# container, which fails the ECS task health check and triggers the
# deployment circuit-breaker's auto-rollback — better than starting
# against a partly-migrated schema.
#
# Set DANTE_SKIP_MIGRATIONS=1 to bypass — useful for emergency boots
# when a migration is the suspect, but never the default.
set -e

if [ "${DANTE_SKIP_MIGRATIONS:-0}" = "1" ]; then
  echo '{"event":"migrations_skipped","reason":"DANTE_SKIP_MIGRATIONS=1"}'
else
  node /app/migrate.js
fi

exec "$@"
