/** Where integration credentials live.
 *
 * Every integration has up to two secret documents: `credentials` (what an
 * admin enters — API key, client id + secret) and `tokens` (what an OAuth
 * flow produces and the sync rotates). Three stores implement the same
 * interface; which one a deployment uses is decided once, by environment:
 *
 *   DANTE_SECRET_STORE=env | secretsmanager | db   (explicit), otherwise
 *   DANTE_USE_SECRETS_MANAGER=1  → secretsmanager
 *   DANTE_SECRET_KEY set         → db
 *   neither                      → env
 *
 * - **env**: `<SLUG>_<FIELD>` variables from `.env` (PERSONIO_CLIENT_ID,
 *   AWORK_CLIENT_ID, AWORK_ACCESS_TOKEN, …). Read-only for credentials —
 *   the UI cannot write here — but tokens are rewritten to `.env` in dev
 *   so the awork refresh flow keeps working locally.
 * - **secretsmanager**: AWS Secrets Manager, `dante/<env>/integration/
 *   <slug>/<kind>`, with the pre-adapter names (`dante/<env>/personio`,
 *   `dante/<env>/awork/client`, `dante/<env>/awork/tokens`) kept for the
 *   two original integrations so existing deployments need no data
 *   migration. Whether a process can read a document is an IAM question:
 *   the web app holds write + describe on credentials and read only on
 *   tokens; the sync Lambda holds read on both. `get` simply fails where
 *   IAM says no.
 * - **db**: an `integration_secret` row per document, AES-256-GCM under
 *   `DANTE_SECRET_KEY` (32 bytes, base64 or hex). The self-hosted option:
 *   simpler, and weaker — the web app holds the key.
 *
 * Nothing here ever returns a secret to a browser; the admin actions only
 * surface `status()`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

import { secretsManager } from "@/lib/aws/clients";
import { openSyncConn } from "@/lib/sync/db";

export type SecretKind = "credentials" | "tokens";
export type SecretDocument = Record<string, unknown>;
export type SecretStatus = { present: boolean; updated_at: Date | null };
export type SecretStoreKind = "env" | "secretsmanager" | "db";

export interface SecretStore {
  readonly kind: SecretStoreKind;
  /** Can an admin store credentials through the UI with this store? */
  readonly writable: boolean;
  /** One line for the settings UI. */
  describe(): string;
  get(slug: string, kind: SecretKind): Promise<SecretDocument | null>;
  put(slug: string, kind: SecretKind, doc: SecretDocument): Promise<void>;
  status(slug: string, kind: SecretKind): Promise<SecretStatus>;
}

export class SecretStoreReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretStoreReadOnlyError";
  }
}

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

let envLoaded = false;
function ensureEnv(): void {
  if (envLoaded) return;
  loadEnv({ path: "../.env" });
  loadEnv();
  envLoaded = true;
}

function envPrefix(slug: string): string {
  return slug.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_";
}

const TOKEN_FIELDS = ["ACCESS_TOKEN", "REFRESH_TOKEN", "EXPIRES_AT"] as const;

class EnvSecretStore implements SecretStore {
  readonly kind = "env" as const;
  readonly writable = false;

  describe(): string {
    return "Environment variables (.env). Credentials are read-only here; set DANTE_SECRET_KEY or DANTE_USE_SECRETS_MANAGER=1 to store them from the UI.";
  }

  async get(slug: string, kind: SecretKind): Promise<SecretDocument | null> {
    ensureEnv();
    const prefix = envPrefix(slug);
    if (kind === "tokens") {
      const access_token = process.env[prefix + "ACCESS_TOKEN"];
      const refresh_token = process.env[prefix + "REFRESH_TOKEN"];
      const expires_at = Number.parseInt(process.env[prefix + "EXPIRES_AT"] ?? "", 10);
      if (!access_token || !refresh_token || !Number.isFinite(expires_at)) return null;
      return { access_token, refresh_token, expires_at };
    }
    const doc: SecretDocument = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (!k.startsWith(prefix) || !v) continue;
      const field = k.slice(prefix.length);
      if ((TOKEN_FIELDS as readonly string[]).includes(field)) continue;
      doc[field.toLowerCase()] = v;
    }
    return Object.keys(doc).length > 0 ? doc : null;
  }

  async put(slug: string, kind: SecretKind, doc: SecretDocument): Promise<void> {
    if (kind !== "tokens") {
      throw new SecretStoreReadOnlyError(
        "The env secret store is read-only for credentials. Put them in .env, or enable the database store (DANTE_SECRET_KEY) / Secrets Manager (DANTE_USE_SECRETS_MANAGER=1).",
      );
    }
    // Prod guard: writing tokens to disk leaks them into the container's
    // ephemeral storage, where they outlive the invocation. In prod the
    // only legitimate token store is Secrets Manager — fail loudly.
    if (process.env.NODE_ENV === "production") {
      throw new SecretStoreReadOnlyError(
        "Refusing to write tokens to .env in production. Set DANTE_USE_SECRETS_MANAGER=1.",
      );
    }
    const prefix = envPrefix(slug);
    const kv: Record<string, string> = {
      [prefix + "ACCESS_TOKEN"]: String(doc.access_token ?? ""),
      [prefix + "REFRESH_TOKEN"]: String(doc.refresh_token ?? ""),
      [prefix + "EXPIRES_AT"]: String(doc.expires_at ?? ""),
    };
    await rewriteDotEnv(kv);
    for (const [k, v] of Object.entries(kv)) process.env[k] = v;
  }

  async status(slug: string, kind: SecretKind): Promise<SecretStatus> {
    return { present: (await this.get(slug, kind)) !== null, updated_at: null };
  }
}

/** Upsert `key=value` lines in the repo-root .env (dev layout) or the
 * local .env. Kept from the pre-adapter token rotation. */
async function rewriteDotEnv(kv: Record<string, string>): Promise<void> {
  // Static `process.cwd()`-anchored paths (with the turbopackIgnore hint)
  // so Turbopack's output tracer doesn't treat the relative `../.env`
  // resolve as "this module may read anything" and copy the whole
  // project tree into `.next/standalone`.
  const cwd = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ cwd, "..", ".env"),
    path.join(/*turbopackIgnore: true*/ cwd, ".env"),
  ];
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
  for (const [key, value] of Object.entries(kv)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx === -1) lines.push(line);
    else lines[idx] = line;
  }
  await fs.writeFile(target, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// AWS Secrets Manager
// ---------------------------------------------------------------------------

/** Names the two original integrations were deployed with. New
 *  integrations follow `integration/<slug>/<kind>`. */
const LEGACY_SECRET_NAMES: Record<string, Partial<Record<SecretKind, string>>> = {
  personio: { credentials: "personio" },
  awork: { credentials: "awork/client", tokens: "awork/tokens" },
};

/** `dante/<env>/<key>`; env defaults to "local". */
export function secretName(slug: string, kind: SecretKind): string {
  const env = process.env.DANTE_ENV?.trim() || "local";
  const key = LEGACY_SECRET_NAMES[slug]?.[kind] ?? `integration/${slug}/${kind}`;
  return `dante/${env}/${key}`;
}

class SecretsManagerStore implements SecretStore {
  readonly kind = "secretsmanager" as const;
  readonly writable = true;

  describe(): string {
    return "AWS Secrets Manager. Credentials are written by the app and read only by the sync.";
  }

  async get(slug: string, kind: SecretKind): Promise<SecretDocument | null> {
    try {
      const res = await secretsManager.send(
        new GetSecretValueCommand({ SecretId: secretName(slug, kind) }),
      );
      if (!res.SecretString) return null;
      return JSON.parse(res.SecretString) as SecretDocument;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  async put(slug: string, kind: SecretKind, doc: SecretDocument): Promise<void> {
    const SecretId = secretName(slug, kind);
    const SecretString = JSON.stringify(doc);
    try {
      await secretsManager.send(new PutSecretValueCommand({ SecretId, SecretString }));
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) throw err;
      // First credential for a new integration: no container exists yet.
      // Terraform only pre-creates the original two; the rest are created
      // on demand under the `integration/` prefix the IAM grants cover.
      await secretsManager.send(
        new CreateSecretCommand({
          Name: SecretId,
          SecretString,
          Description: `Dante integration "${slug}" ${kind}`,
          KmsKeyId: process.env.DANTE_SECRETS_KMS_KEY_ARN?.trim() || undefined,
        }),
      );
    }
  }

  async status(slug: string, kind: SecretKind): Promise<SecretStatus> {
    try {
      const res = await secretsManager.send(
        new DescribeSecretCommand({ SecretId: secretName(slug, kind) }),
      );
      const stages = Object.values(res.VersionIdsToStages ?? {});
      const present = stages.some((s) => s?.includes("AWSCURRENT"));
      return { present, updated_at: present ? (res.LastChangedDate ?? null) : null };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { present: false, updated_at: null };
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Encrypted database rows
// ---------------------------------------------------------------------------

export const SECRET_KEY_VERSION = 1;

/** Parse DANTE_SECRET_KEY: 32 bytes as base64 (44 chars) or hex (64). */
export function parseSecretKey(raw: string | undefined): Buffer {
  const s = raw?.trim() ?? "";
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  if (s.length > 0 && b.length === 32) return b;
  throw new Error(
    "DANTE_SECRET_KEY must be 32 bytes, base64 or hex. Generate one with: openssl rand -base64 32",
  );
}

export type EncryptedSecret = { ciphertext: string; iv: string; tag: string; key_version: number };

/** AES-256-GCM. The (slug, kind) pair is bound in as additional
 *  authenticated data so a ciphertext copied onto another row won't
 *  decrypt. */
export function encryptSecret(
  key: Buffer,
  slug: string,
  kind: SecretKind,
  doc: SecretDocument,
): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${slug}:${kind}`));
  const ct = Buffer.concat([cipher.update(JSON.stringify(doc), "utf8"), cipher.final()]);
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    key_version: SECRET_KEY_VERSION,
  };
}

export function decryptSecret(
  key: Buffer,
  slug: string,
  kind: SecretKind,
  enc: EncryptedSecret,
): SecretDocument {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
  decipher.setAAD(Buffer.from(`${slug}:${kind}`));
  decipher.setAuthTag(Buffer.from(enc.tag, "base64"));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(pt.toString("utf8")) as SecretDocument;
}

class DbSecretStore implements SecretStore {
  readonly kind = "db" as const;
  readonly writable = true;
  private key: Buffer;

  constructor() {
    this.key = parseSecretKey(process.env.DANTE_SECRET_KEY);
  }

  describe(): string {
    return "Encrypted in the database (AES-256-GCM under DANTE_SECRET_KEY).";
  }

  async get(slug: string, kind: SecretKind): Promise<SecretDocument | null> {
    const conn = await openSyncConn();
    try {
      const r = await conn.query<EncryptedSecret>(
        `SELECT ciphertext, iv, tag, key_version FROM integration_secret
          WHERE integration_slug = $1 AND kind = $2`,
        [slug, kind],
      );
      const row = r.rows[0];
      if (!row) return null;
      return decryptSecret(this.key, slug, kind, row);
    } finally {
      await conn.end();
    }
  }

  async put(slug: string, kind: SecretKind, doc: SecretDocument): Promise<void> {
    const enc = encryptSecret(this.key, slug, kind, doc);
    const conn = await openSyncConn();
    try {
      await conn.query(
        `INSERT INTO integration_secret (integration_slug, kind, ciphertext, iv, tag, key_version, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (integration_slug, kind) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
               key_version = EXCLUDED.key_version, updated_at = now()`,
        [slug, kind, enc.ciphertext, enc.iv, enc.tag, enc.key_version],
      );
    } finally {
      await conn.end();
    }
  }

  async status(slug: string, kind: SecretKind): Promise<SecretStatus> {
    const conn = await openSyncConn();
    try {
      const r = await conn.query<{ updated_at: Date }>(
        `SELECT updated_at FROM integration_secret WHERE integration_slug = $1 AND kind = $2`,
        [slug, kind],
      );
      const row = r.rows[0];
      return { present: Boolean(row), updated_at: row?.updated_at ?? null };
    } finally {
      await conn.end();
    }
  }
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function resolveSecretStoreKind(): SecretStoreKind {
  const explicit = process.env.DANTE_SECRET_STORE?.trim();
  if (explicit === "env" || explicit === "secretsmanager" || explicit === "db") return explicit;
  if (process.env.DANTE_USE_SECRETS_MANAGER === "1") return "secretsmanager";
  if (process.env.DANTE_SECRET_KEY?.trim()) return "db";
  return "env";
}

let cached: { kind: SecretStoreKind; store: SecretStore } | null = null;

export function getSecretStore(): SecretStore {
  ensureEnv();
  const kind = resolveSecretStoreKind();
  if (cached && cached.kind === kind) return cached.store;
  const store: SecretStore =
    kind === "secretsmanager"
      ? new SecretsManagerStore()
      : kind === "db"
        ? new DbSecretStore()
        : new EnvSecretStore();
  cached = { kind, store };
  return store;
}
