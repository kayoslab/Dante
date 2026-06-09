/** Run pending Drizzle migrations against the configured DATABASE_URL.
 *
 * Designed for two execution contexts:
 *   - Local CLI: `npx tsx scripts/migrate.ts` — same env vars as the app.
 *   - Container entrypoint: `node migrate.js` (esbuild-bundled) runs
 *     before `node server.js`, so the schema is current before the
 *     first request lands.
 *
 * Connection-string resolution mirrors `lib/db/client.ts` and
 * `lib/sync/db.ts`: DATABASE_URL wins, else compose from DB_USERNAME +
 * DB_PASSWORD + DANTE_DATABASE_ENDPOINT + DANTE_DATABASE_NAME (the ECS
 * task pattern).
 *
 * Concurrency safety: Drizzle's migrator acquires a Postgres advisory
 * lock for the duration of the migration step, so multiple ECS tasks
 * starting at the same time will serialize automatically — only one
 * applies migrations; the others wait and then see "nothing to do".
 *
 * Failure mode: a failed migration exits non-zero. The container
 * entrypoint propagates that, which fails the ECS task health check
 * and triggers the deployment circuit-breaker's auto-rollback. Catching
 * the error and starting the app anyway would silently run against a
 * partly-migrated schema — deliberately don't.
 */
import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

const MIGRATIONS_FOLDER =
  process.env.DANTE_MIGRATIONS_FOLDER ??
  path.resolve(__dirname, "..", "lib", "db", "migrations");

function resolveConnectionString(): string {
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const username = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;
  if (username && password && endpoint && dbname) {
    return `postgresql://${username}:${encodeURIComponent(password)}@${endpoint}/${dbname}?sslmode=require`;
  }

  throw new Error(
    "migrate: no DATABASE_URL and no DB_USERNAME / DB_PASSWORD / " +
      "DANTE_DATABASE_ENDPOINT / DANTE_DATABASE_NAME — confirm the ECS task " +
      "definition injects the RDS-managed secret, or set DATABASE_URL " +
      "explicitly for local runs.",
  );
}

async function main(): Promise<void> {
  const connectionString = resolveConnectionString();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const db = drizzle(client);
    const started = Date.now();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    const took_ms = Date.now() - started;
    // One structured line so CloudWatch Logs Insights groups boot timings.
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "migrations_complete",
        took_ms,
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      event: "migrations_failed",
      name: err instanceof Error ? err.name : "Error",
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
