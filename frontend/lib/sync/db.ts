/** Standalone Postgres connection for the sync layer.
 *
 * Single Client (not a pool) because each sync invocation is a discrete
 * script run — local CLI or Lambda — not a long-running server.
 *
 * Connection-credential resolution (first match wins):
 *   1. Env var `DATABASE_URL` (dev / local CLI / explicit override).
 *   2. IAM auth via `DANTE_USE_IAM_DB_AUTH=1` + `DANTE_APP_DB_USERNAME`
 *      + `DANTE_DATABASE_ENDPOINT/NAME`. This is the prod runtime path
 *      — both the in-process sync (web app calling runSyncAction) and
 *      the scheduled sync Lambda hit this branch. No static password.
 *   3. Pre-resolved DB_USERNAME / DB_PASSWORD from the ECS task
 *      definition. Kept for break-glass and for callers that pre-load
 *      credentials.
 *   4. Secrets Manager: read `DANTE_DATABASE_SECRET_ARN` directly.
 *      Legacy Lambda path; preserved for backwards compat with any
 *      deploy that hasn't been migrated to IAM yet.
 *
 * For writes that need compile-time column safety, wrap the client with
 * `syncDrizzle(conn)` at the call site — this returns a Drizzle instance
 * bound to the same connection, so transactions still work correctly.
 */
import { GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, type ClientConfig } from "pg";
import { config as loadEnv } from "dotenv";

import { secretsManager } from "@/lib/aws/clients";
import {
  getRdsAuthToken,
  getRdsCaBundle,
  parseDatabaseEndpoint,
  useIamDbAuth,
} from "@/lib/db/_rds-iam";
import * as schema from "@/lib/db/schema";

export type SyncSchema = typeof schema;
export type SyncDB = NodePgDatabase<SyncSchema>;

/** Build the Client config — either from a connection string (legacy
 * paths) or with fields + IAM token + ssl ca (the runtime default). */
async function resolveClientConfig(): Promise<ClientConfig> {
  loadEnv({ path: "../.env" });
  loadEnv();
  const fromEnv = process.env.DATABASE_URL;
  if (fromEnv) return { connectionString: fromEnv };

  const endpoint = process.env.DANTE_DATABASE_ENDPOINT;
  const dbname = process.env.DANTE_DATABASE_NAME;

  // IAM-auth path — preferred. No static password lives anywhere on
  // this code path: the token is generated fresh from the caller's
  // IAM credentials (ECS task role or Lambda execution role).
  if (useIamDbAuth()) {
    const username = process.env.DANTE_APP_DB_USERNAME;
    if (!username || !endpoint || !dbname) {
      throw new Error(
        "DANTE_USE_IAM_DB_AUTH=1 requires DANTE_APP_DB_USERNAME, " +
          "DANTE_DATABASE_ENDPOINT, and DANTE_DATABASE_NAME.",
      );
    }
    const { host, port } = parseDatabaseEndpoint(endpoint);
    const token = await getRdsAuthToken(host, port, username);
    return {
      host,
      port,
      user: username,
      database: dbname,
      password: token,
      ssl: { ca: getRdsCaBundle() },
    };
  }

  // Pre-resolved username + password (injected by ECS into the web-app
  // process via the task definition's `secrets:` block). The web app
  // uses this path when `/settings` triggers an in-process sync via
  // `runSyncAction`; we already have credentials, no reason to do a
  // second Secrets Manager round-trip. Kept for break-glass.
  const username = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  if (username && password && endpoint && dbname) {
    const pw = encodeURIComponent(password);
    return {
      connectionString: `postgresql://${username}:${pw}@${endpoint}/${dbname}?uselibpqcompat=true&sslmode=require`,
    };
  }

  // Legacy Secrets Manager path. Retained until every sync runtime is
  // confirmed on IAM auth; can be removed once that's done.
  const secretArn = process.env.DANTE_DATABASE_SECRET_ARN;
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
    const pw = encodeURIComponent(creds.password);
    return {
      connectionString: `postgresql://${creds.username}:${pw}@${endpoint}/${dbname}?uselibpqcompat=true&sslmode=require`,
    };
  }

  throw new Error(
    "DATABASE_URL is not set, DANTE_USE_IAM_DB_AUTH is not enabled, " +
      "neither DB_USERNAME/DB_PASSWORD nor DANTE_DATABASE_SECRET_ARN are " +
      "present, and DANTE_DATABASE_ENDPOINT / DANTE_DATABASE_NAME are not " +
      "both set. In dev: copy .env.example to .env and start Postgres via " +
      "`docker compose up -d`. In prod: confirm the Lambda / ECS env wiring.",
  );
}

export async function openSyncConn(): Promise<Client> {
  const config = await resolveClientConfig();
  const client = new Client(config);
  await client.connect();
  return client;
}

/** Wrap a sync client with Drizzle. Use at the call site — the wrapper
 * is cheap and ties to the underlying connection, so BEGIN/COMMIT issued
 * via raw `conn.query` still cover the typed writes. */
export function syncDrizzle(conn: Client): SyncDB {
  return drizzle(conn, { schema });
}
