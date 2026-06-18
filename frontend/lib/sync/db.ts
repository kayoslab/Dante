/** Standalone Postgres connection for the sync layer.
 *
 * Single Client (not a pool) because each sync invocation is a discrete
 * script run — local CLI or Lambda — not a long-running server.
 *
 * DATABASE_URL resolution (first match wins):
 *   1. Env var `DATABASE_URL` (dev / local CLI / explicit override).
 *   2. Secrets Manager: read `DANTE_DATABASE_SECRET_ARN` for `{username,
 *      password}`, compose URL using `DANTE_DATABASE_ENDPOINT` +
 *      `DANTE_DATABASE_NAME`. This is the prod Lambda path.
 *
 * For writes that need compile-time column safety, wrap the client with
 * `syncDrizzle(conn)` at the call site — this returns a Drizzle instance
 * bound to the same connection, so transactions still work correctly.
 */
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { config as loadEnv } from "dotenv";

import { secretsManager } from "@/lib/aws/clients";
import * as schema from "@/lib/db/schema";

export type SyncSchema = typeof schema;
export type SyncDB = NodePgDatabase<SyncSchema>;

async function resolveDatabaseUrl(): Promise<string> {
  loadEnv({ path: "../.env" });
  loadEnv();
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return fromEnv;

  const secretArn = process.env.DANTE_DATABASE_SECRET_ARN;
  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;
  if (secretArn && endpoint && dbname) {
    const res = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
    if (!res.SecretString) {
      throw new Error(`RDS secret ${secretArn} returned no SecretString.`);
    }
    const creds = JSON.parse(res.SecretString) as {
      username?: string;
      password?: string;
    };
    if (!creds.username || !creds.password) {
      throw new Error(
        `RDS secret ${secretArn} missing username/password fields.`,
      );
    }
    // Endpoint shape from RDS is `host:port`. URL-encode the password
    // so special characters survive the connection string parser.
    // `uselibpqcompat=true` — see the matching comment in lib/db/client.ts.
    const pw = encodeURIComponent(creds.password);
    return `postgresql://${creds.username}:${pw}@${endpoint}/${dbname}?uselibpqcompat=true&sslmode=require`;
  }

  throw new Error(
    "DATABASE_URL is not set, and DANTE_DATABASE_{SECRET_ARN,ENDPOINT,NAME} " +
      "are not all present for the Secrets Manager path. In dev: copy " +
      ".env.example to .env and start Postgres via `docker compose up -d`. " +
      "In prod: confirm the Lambda env vars are populated by the sync-lambda module.",
  );
}

export async function openSyncConn(): Promise<Client> {
  const url = await resolveDatabaseUrl();
  const client = new Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Wrap a sync client with Drizzle. Use at the call site — the wrapper
 * is cheap and ties to the underlying connection, so BEGIN/COMMIT issued
 * via raw `conn.query` still cover the typed writes. */
export function syncDrizzle(conn: Client): SyncDB {
  return drizzle(conn, { schema });
}
