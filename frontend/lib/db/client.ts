import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  getRdsAuthToken,
  getRdsCaBundle,
  parseDatabaseEndpoint,
  useIamDbAuth,
} from "./_rds-iam";
import * as schema from "./schema";

declare global {
  // Module-scope singleton across Next.js dev hot-reloads to avoid leaking
  // pool connections every time a server file changes.
  var __pgPool: Pool | undefined;
}

/** Resolve a Postgres connection string from the environment.
 *
 * In dev: `DATABASE_URL` from `.env`.
 *
 * In prod with static creds (legacy path, kept for boot-time migrations
 * and as a break-glass): the task definition injects `DB_USERNAME` +
 * `DB_PASSWORD` from the RDS-managed secret via the native `secrets:`
 * block, and `DANTE_DATABASE_ENDPOINT` + `DANTE_DATABASE_NAME` as
 * plaintext env. We compose the URL here so the rest of the app stays
 * unchanged.
 *
 * In prod with IAM auth (default for the app runtime): this function
 * is bypassed entirely — see `buildIamPool()` below. */
function resolveConnectionString(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const username = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;
  if (username && password && endpoint && dbname) {
    // URL-encode the password so a `:` or `@` survives the parser.
    // `uselibpqcompat=true` restores the pre-tightening pg-connection-string
    // semantics where `sslmode=require` means "encrypt but don't verify the
    // chain" — needed when this static-creds path was the only one. The
    // IAM path below uses verify-full with the bundled RDS Global CA.
    return `postgresql://${username}:${encodeURIComponent(password)}@${endpoint}/${dbname}?uselibpqcompat=true&sslmode=require`;
  }

  throw new Error(
    "DATABASE_URL is not set, and DB_USERNAME / DB_PASSWORD / " +
      "DANTE_DATABASE_ENDPOINT / DANTE_DATABASE_NAME are not all present. " +
      "In dev: copy .env.example to .env and start Postgres via " +
      "`docker compose up -d`. In prod with IAM auth: set " +
      "DANTE_USE_IAM_DB_AUTH=1 and DANTE_APP_DB_USERNAME instead.",
  );
}

/** Build the IAM-auth Pool. `password` is a callback — pg invokes it
 * per new connection, so `getRdsAuthToken()` gets a chance to refresh
 * the 15-minute token whenever the pool grows. SSL uses the bundled
 * RDS Global CA for proper verify-full chain validation. */
function buildIamPool(opts: {
  max: number;
  stmt_timeout_ms: number;
}): Pool {
  const username = process.env.DANTE_APP_DB_USERNAME;
  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;
  if (!username || !endpoint || !dbname) {
    throw new Error(
      "DANTE_USE_IAM_DB_AUTH=1 requires DANTE_APP_DB_USERNAME, " +
        "DANTE_DATABASE_ENDPOINT, and DANTE_DATABASE_NAME. " +
        "See terraform/envs/prod/main.tf for the wiring.",
    );
  }
  const { host, port } = parseDatabaseEndpoint(endpoint);
  return new Pool({
    host,
    port,
    user: username,
    database: dbname,
    password: () => getRdsAuthToken(host, port, username),
    ssl: { ca: getRdsCaBundle() },
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(opts.stmt_timeout_ms > 0
      ? { options: `-c statement_timeout=${opts.stmt_timeout_ms}` }
      : {}),
  });
}

function getPool(): Pool {
  if (!global.__pgPool) {
    // `max` is bounded so a traffic spike can't exhaust RDS connections.
    // 40-user workload: at most ~5 concurrent server-rendered requests
    // hitting the DB at once. RDS t4g.micro defaults to ~80 max
    // connections — keep room for sync Lambda + admin tools.
    // Override with PGPOOL_MAX if scaling assumptions change.
    const max = Number.parseInt(process.env.PGPOOL_MAX ?? "5", 10);
    // Per-connection `statement_timeout`. Caps any single query so a
    // pathological N+1 or a runaway calendar window can't pin a pool
    // connection forever. Applies to the API pool only — the sync
    // pipeline uses `openSyncConn` (a separate Client) so long-running
    // rollups aren't affected. Passed as a startup parameter so the
    // server applies it before ReadyForQuery — no race with the first
    // user query on a fresh connection.
    const stmt_timeout_ms = Number.parseInt(
      process.env.PG_STATEMENT_TIMEOUT_MS ?? "15000",
      10,
    );
    const poolMax = Number.isFinite(max) && max > 0 ? max : 5;
    global.__pgPool = useIamDbAuth()
      ? buildIamPool({ max: poolMax, stmt_timeout_ms })
      : new Pool({
          connectionString: resolveConnectionString(),
          max: poolMax,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
          ...(stmt_timeout_ms > 0
            ? { options: `-c statement_timeout=${stmt_timeout_ms}` }
            : {}),
        });
  }
  return global.__pgPool;
}

export const db = drizzle(getPool(), { schema });
export type DB = typeof db;
