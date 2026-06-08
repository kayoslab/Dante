import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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
 * In prod (ECS): the task definition injects `DB_USERNAME` + `DB_PASSWORD`
 * from the RDS-managed secret via the native `secrets:` block, and
 * `DANTE_DATABASE_ENDPOINT` + `DANTE_DATABASE_NAME` as plaintext env.
 * We compose the URL here so the rest of the app stays unchanged. */
function resolveConnectionString(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const username = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;
  if (username && password && endpoint && dbname) {
    // URL-encode the password so a `:` or `@` survives the parser.
    return `postgresql://${username}:${encodeURIComponent(password)}@${endpoint}/${dbname}?sslmode=require`;
  }

  throw new Error(
    "DATABASE_URL is not set, and DB_USERNAME / DB_PASSWORD / " +
      "DANTE_DATABASE_ENDPOINT / DANTE_DATABASE_NAME are not all present. " +
      "In dev: copy .env.example to .env and start Postgres via " +
      "`docker compose up -d`. In prod: confirm the ECS task definition " +
      "injects the RDS-managed secret into DB_USERNAME / DB_PASSWORD.",
  );
}

function getPool(): Pool {
  if (!global.__pgPool) {
    // `max` is bounded so a traffic spike can't exhaust RDS connections.
    // 40-user workload: at most ~5 concurrent server-rendered requests
    // hitting the DB at once. RDS t4g.micro defaults to ~80 max
    // connections — keep room for sync Lambda + admin tools.
    // Override with PGPOOL_MAX if scaling assumptions change.
    const max = Number.parseInt(process.env.PGPOOL_MAX ?? "5", 10);
    global.__pgPool = new Pool({
      connectionString: resolveConnectionString(),
      max: Number.isFinite(max) && max > 0 ? max : 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return global.__pgPool;
}

export const db = drizzle(getPool(), { schema });
export type DB = typeof db;
