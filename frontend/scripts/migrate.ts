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
 * task pattern). The migration runner deliberately stays on the static
 * `dante_admin` credential because it needs DDL — the runtime IAM auth
 * path connects as `dante_app` which only has read/write grants.
 *
 * Two-phase work on every boot:
 *   1. Apply `lib/db/iam-bootstrap.sql` (CREATE USER dante_app + grants).
 *      Idempotent — each statement guards against the object existing.
 *      Bundled into this binary via esbuild's text loader, so the
 *      runner stays single-file.
 *   2. Apply pending Drizzle migrations.
 *
 * Concurrency safety: Drizzle's migrator acquires a Postgres advisory
 * lock for the duration of the migration step, so multiple ECS tasks
 * starting at the same time will serialize automatically — only one
 * applies migrations; the others wait and then see "nothing to do".
 * The IAM bootstrap doesn't take a lock — concurrent CREATE USER calls
 * collide on `duplicate_object` which the SQL catches, so it's safe
 * to run from multiple tasks simultaneously.
 *
 * Failure mode: a failed migration exits non-zero. The container
 * entrypoint propagates that, which fails the ECS task health check
 * and triggers the deployment circuit-breaker's auto-rollback. Catching
 * the error and starting the app anyway would silently run against a
 * partly-migrated schema — deliberately don't.
 */
import path from "node:path";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Dual-context load of the IAM bootstrap SQL:
//  - Container bundle: esbuild's text loader inlines the file via the
//    require() below (single-file binary, no runtime filesystem read).
//  - Local CLI (`npx tsx scripts/migrate.ts`): tsx has no `.sql` loader —
//    the require throws a SyntaxError — so fall back to reading the file
//    from the repo. The previous static ESM import broke the local path
//    entirely (the runner crashed before connecting, leaving dev DBs
//    silently unmigrated).
function loadIamBootstrapSql(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../lib/db/iam-bootstrap.sql") as unknown;
    if (typeof mod === "string") return mod;
    const dflt = (mod as { default?: unknown }).default;
    if (typeof dflt === "string") return dflt;
    throw new Error("unexpected .sql module shape");
  } catch {
    return readFileSync(
      path.resolve(__dirname, "..", "lib", "db", "iam-bootstrap.sql"),
      "utf-8",
    );
  }
}
const iamBootstrapSql = loadIamBootstrapSql();

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
    // `uselibpqcompat=true` — see the matching comment in lib/db/client.ts.
    return `postgresql://${username}:${encodeURIComponent(password)}@${endpoint}/${dbname}?uselibpqcompat=true&sslmode=require`;
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
    // Phase 1: IAM bootstrap. Idempotent CREATE USER + GRANTs so the
    // app's IAM-auth runtime has someone to authenticate as. Safe to
    // run on every boot (the SQL guards against duplicates).
    const bootstrap_started = Date.now();
    await client.query(iamBootstrapSql);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "info",
        event: "iam_bootstrap_complete",
        took_ms: Date.now() - bootstrap_started,
      }),
    );

    // Phase 2: Drizzle schema migrations.
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
