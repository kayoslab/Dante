/** Secret loading for the sync layer.
 *
 * Resolution order (per credential):
 *   1. AWS Secrets Manager — if `DANTE_USE_SECRETS_MANAGER=1` is set.
 *   2. Environment variables (`.env` in dev, ECS task env in prod-as-fallback).
 *
 * The Secrets Manager path runs identical code in dev (LocalStack via
 * AWS_ENDPOINT_URL) and prod (real AWS). Bootstrap stays simple: seed
 * LocalStack with `scripts/seed-secrets.ts` from your `.env`, then flip
 * DANTE_USE_SECRETS_MANAGER on and the env vars become unused.
 *
 * awork tokens get rotated on every sync. In env mode they're rewritten
 * to `.env`; in Secrets Manager mode they're PutSecretValue'd in place.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

import { secretsManager } from "@/lib/aws/clients";

let envLoaded = false;
function ensureEnv() {
  if (envLoaded) return;
  loadEnv({ path: "../.env" });
  loadEnv();
  envLoaded = true;
}

function useSecretsManager(): boolean {
  return process.env.DANTE_USE_SECRETS_MANAGER === "1";
}

/** Secret name convention: `dante/<env>/<key>`. Default env = "local". */
function secretName(key: string): string {
  const env = process.env.DANTE_ENV?.trim() || "local";
  return `dante/${env}/${key}`;
}

async function readJsonSecret<T>(key: string): Promise<T | null> {
  try {
    const res = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: secretName(key) }),
    );
    if (!res.SecretString) return null;
    return JSON.parse(res.SecretString) as T;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return null;
    throw err;
  }
}

async function writeJsonSecret(key: string, value: unknown): Promise<void> {
  await secretsManager.send(
    new PutSecretValueCommand({
      SecretId: secretName(key),
      SecretString: JSON.stringify(value),
    }),
  );
}

export type PersonioCredentials = {
  client_id: string;
  client_secret: string;
};

export class CredentialsMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsMissingError";
  }
}

export async function loadPersonioCredentials(): Promise<PersonioCredentials> {
  if (useSecretsManager()) {
    const sm = await readJsonSecret<PersonioCredentials>("personio");
    if (sm?.client_id && sm?.client_secret) return sm;
    throw new CredentialsMissingError(
      `Personio credentials not found in Secrets Manager at ${secretName("personio")}. ` +
        `Seed it with: tsx scripts/seed-secrets.ts`,
    );
  }
  ensureEnv();
  const client_id = process.env.PERSONIO_CLIENT_ID;
  const client_secret = process.env.PERSONIO_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    throw new CredentialsMissingError(
      "Personio credentials not found. Set PERSONIO_CLIENT_ID and " +
        "PERSONIO_CLIENT_SECRET in .env, or flip DANTE_USE_SECRETS_MANAGER=1.",
    );
  }
  return { client_id, client_secret };
}

export type AworkClientCredentials = {
  client_id: string;
  client_secret: string | null; // null for Public clients (PKCE only)
};

export async function loadAworkClientCredentials(): Promise<AworkClientCredentials> {
  if (useSecretsManager()) {
    const sm = await readJsonSecret<AworkClientCredentials>("awork/client");
    if (sm?.client_id) {
      return { client_id: sm.client_id, client_secret: sm.client_secret ?? null };
    }
    throw new CredentialsMissingError(
      `awork client credentials not found in Secrets Manager at ${secretName("awork/client")}.`,
    );
  }
  ensureEnv();
  const client_id = process.env.AWORK_CLIENT_ID;
  if (!client_id) {
    throw new CredentialsMissingError(
      "awork client_id not found. Set AWORK_CLIENT_ID in .env.",
    );
  }
  return {
    client_id,
    client_secret: process.env.AWORK_CLIENT_SECRET || null,
  };
}

/** awork OAuth tokens — refreshed and rewritten on each sync. */
export type AworkTokens = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
};

export async function loadAworkTokens(): Promise<AworkTokens | null> {
  if (useSecretsManager()) {
    const sm = await readJsonSecret<AworkTokens>("awork/tokens");
    if (!sm) return null;
    if (!sm.access_token || !sm.refresh_token || !Number.isFinite(sm.expires_at)) {
      return null;
    }
    return sm;
  }
  ensureEnv();
  const access_token = process.env.AWORK_ACCESS_TOKEN;
  const refresh_token = process.env.AWORK_REFRESH_TOKEN;
  const expires_at_str = process.env.AWORK_EXPIRES_AT;
  if (!access_token || !refresh_token || !expires_at_str) return null;
  const expires_at = Number.parseInt(expires_at_str, 10);
  if (!Number.isFinite(expires_at)) return null;
  return { access_token, refresh_token, expires_at };
}

/** Persist rotated awork tokens. Secrets Manager mode updates the secret;
 * env mode rewrites .env (legacy dev flow). */
export async function storeAworkTokens(t: AworkTokens): Promise<void> {
  if (useSecretsManager()) {
    await writeJsonSecret("awork/tokens", t);
    return;
  }
  // Prod guard: writing tokens to disk (the .env fallback) leaks them
  // into the Lambda container's ephemeral storage, where they outlive
  // the invocation and may surface in forensic dumps. In prod the only
  // legitimate token store is Secrets Manager — fail loudly rather than
  // silently degrading.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "storeAworkTokens: refusing to write tokens to .env in production. " +
        "Set DANTE_USE_SECRETS_MANAGER=1 on the Lambda environment.",
    );
  }
  // Prefer the repo-root .env when present (dev layout), otherwise local.
  const candidates = [path.resolve("../.env"), path.resolve(".env")];
  let target = candidates[0];
  for (const c of candidates) {
    try {
      await fs.access(c);
      target = c;
      break;
    } catch {
      /* skip */
    }
  }
  let body = "";
  try {
    body = await fs.readFile(target, "utf-8");
  } catch {
    /* new file */
  }
  const lines = body.split("\n");
  const setKv = (key: string, value: string) => {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const kv = `${key}=${value}`;
    if (idx === -1) lines.push(kv);
    else lines[idx] = kv;
  };
  setKv("AWORK_ACCESS_TOKEN", t.access_token);
  setKv("AWORK_REFRESH_TOKEN", t.refresh_token);
  setKv("AWORK_EXPIRES_AT", String(t.expires_at));
  await fs.writeFile(target, lines.join("\n"));
  // Keep process env in sync so the rest of this run uses the new values.
  process.env.AWORK_ACCESS_TOKEN = t.access_token;
  process.env.AWORK_REFRESH_TOKEN = t.refresh_token;
  process.env.AWORK_EXPIRES_AT = String(t.expires_at);
}
