-- RDS IAM-auth bootstrap for the runtime app user.
--
-- This file is executed by `scripts/migrate.ts` at every container
-- start (bundled into `migrate.js` via the esbuild text loader, then
-- run as a single multi-statement query before Drizzle migrations).
-- It's also runnable interactively if you ever need to bootstrap a
-- new RDS instance by hand:
--
--   PGPASSWORD=<from secrets> psql \
--     "host=<rds endpoint> port=5432 dbname=dante user=dante_admin sslmode=require" \
--     -f lib/db/iam-bootstrap.sql
--
-- Idempotent: re-running is safe. Each block guards against the object
-- already existing. Uses only standard SQL — no psql metacommands like
-- `\du` — because pg.Client.query() doesn't understand them.
--
-- After this runs, the app + sync Lambda can connect as `dante_app`
-- using an IAM-signed token in place of a password. The master
-- credential (`dante_admin`) stays for migrations and break-glass.

-- 1. The runtime user. No password — RDS only accepts IAM tokens once
--    we GRANT rds_iam below, so a static password would never be used.
DO $$
BEGIN
  CREATE USER dante_app;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'dante_app already exists, skipping CREATE USER';
END
$$;

-- 2. Enable IAM auth for this user.
GRANT rds_iam TO dante_app;

-- 3. Database connect — required to open any session.
DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO dante_app',
    current_database()
  );
END
$$;

-- 4. Schema usage + read/write across every existing table. The
--    pg_read_all_data / pg_write_all_data predefined roles (PG 14+) are
--    a cleaner alternative to looping GRANTs over every table. They
--    also automatically extend to tables created by future migrations.
GRANT USAGE ON SCHEMA public TO dante_app;
GRANT pg_read_all_data TO dante_app;
GRANT pg_write_all_data TO dante_app;

-- 5. Sequences are NOT covered by pg_write_all_data. Grant explicitly,
--    and set the default for future sequences too — every Drizzle
--    migration that adds a serial column would otherwise need a manual
--    follow-up grant.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dante_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dante_app;

-- 6. The advisory-lock pair Drizzle uses during migrations is global
--    (no permission needed). No additional grants required for the
--    app to call `pg_try_advisory_lock` / `pg_advisory_unlock`.
