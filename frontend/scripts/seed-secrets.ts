/** Seed AWS Secrets Manager (LocalStack in dev, real AWS in prod) from
 * the values already in your `.env`. Idempotent — uses Create-or-Update.
 *
 * Usage:
 *   AWS_ENDPOINT_URL=http://localhost:4566 tsx scripts/seed-secrets.ts
 *
 * In CI / prod you'd seed real secrets via Terraform + a one-time admin
 * push, not this script. This script exists so local dev can flip
 * DANTE_USE_SECRETS_MANAGER=1 and have everything work.
 */
import { config as loadEnv } from "dotenv";
import {
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-secrets-manager";

import { awsEndpointSummary, secretsManager } from "@/lib/aws/clients";

loadEnv({ path: "../.env" });
loadEnv();

const env = process.env.DANTE_ENV?.trim() || "local";
const prefix = `dante/${env}`;

type SeedEntry = {
  key: string;
  value: Record<string, unknown> | null;
  optional?: boolean;
};

function compactPersonio(): SeedEntry {
  const client_id = process.env.PERSONIO_CLIENT_ID;
  const client_secret = process.env.PERSONIO_CLIENT_SECRET;
  if (!client_id || !client_secret) {
    return { key: "personio", value: null };
  }
  return { key: "personio", value: { client_id, client_secret } };
}

function compactAworkClient(): SeedEntry {
  const client_id = process.env.AWORK_CLIENT_ID;
  if (!client_id) return { key: "awork/client", value: null, optional: true };
  return {
    key: "awork/client",
    value: {
      client_id,
      client_secret: process.env.AWORK_CLIENT_SECRET || null,
    },
    optional: true,
  };
}

function compactAworkTokens(): SeedEntry {
  const access_token = process.env.AWORK_ACCESS_TOKEN;
  const refresh_token = process.env.AWORK_REFRESH_TOKEN;
  const expires_at_str = process.env.AWORK_EXPIRES_AT;
  if (!access_token || !refresh_token || !expires_at_str) {
    return { key: "awork/tokens", value: null, optional: true };
  }
  return {
    key: "awork/tokens",
    value: {
      access_token,
      refresh_token,
      expires_at: Number.parseInt(expires_at_str, 10),
    },
    optional: true,
  };
}

async function upsertSecret(name: string, value: unknown): Promise<"created" | "updated"> {
  try {
    await secretsManager.send(new DescribeSecretCommand({ SecretId: name }));
    await secretsManager.send(
      new PutSecretValueCommand({
        SecretId: name,
        SecretString: JSON.stringify(value),
      }),
    );
    return "updated";
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await secretsManager.send(
        new CreateSecretCommand({
          Name: name,
          SecretString: JSON.stringify(value),
        }),
      );
      return "created";
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const summary = awsEndpointSummary();
  console.log(`Seeding secrets → ${summary.mode} (${summary.endpoint}, ${summary.region})`);
  console.log(`Prefix: ${prefix}\n`);

  const entries = [compactPersonio(), compactAworkClient(), compactAworkTokens()];
  for (const entry of entries) {
    const fullName = `${prefix}/${entry.key}`;
    if (entry.value === null) {
      const label = entry.optional ? "skipped" : "MISSING";
      console.log(`  ${label.padEnd(8)} ${fullName}`);
      if (!entry.optional) {
        console.error(`\nRequired secret ${entry.key} not found in env. Aborting.`);
        process.exitCode = 1;
        return;
      }
      continue;
    }
    const action = await upsertSecret(fullName, entry.value);
    console.log(`  ${action.padEnd(8)} ${fullName}`);
  }
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("seed-secrets failed:", err);
  process.exit(1);
});
