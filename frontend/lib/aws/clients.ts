/** AWS SDK client factory — environment-aware.
 *
 * One env var (`AWS_ENDPOINT_URL`) flips every client between LocalStack
 * (local dev) and real AWS (prod). The application code never branches
 * on environment — it just imports `secretsManager` / `kms` and uses
 * them. Same code path in both places.
 *
 * Region pinning: `AWS_REGION` defaults to eu-central-1 (Frankfurt) per
 * the GDPR posture. Override only if you have a reason.
 *
 * Credentials: when AWS_ENDPOINT_URL is set we pass dummy creds so the
 * SDK doesn't go looking for ~/.aws/credentials. In prod we let the SDK
 * resolve via the standard chain (ECS task role / Lambda execution role).
 */
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { KMSClient } from "@aws-sdk/client-kms";

const endpoint = process.env.AWS_ENDPOINT_URL?.trim() || undefined;
const region = process.env.AWS_REGION?.trim() || "eu-central-1";

export const isLocalStack = Boolean(endpoint);

const sharedConfig = endpoint
  ? {
      endpoint,
      region,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      // forcePathStyle for S3-shaped URLs; harmless for other services.
      forcePathStyle: true,
    }
  : { region };

/** Module-scope singletons. Lambda invocations and Next.js server processes
 * reuse the same socket pool across requests; creating fresh clients per
 * call is a known cold-start tax. */
export const secretsManager = new SecretsManagerClient(sharedConfig);
export const kms = new KMSClient(sharedConfig);

/** Sanity-check the endpoint config. Useful in scripts that need to fail
 * fast when LocalStack isn't running. */
export function awsEndpointSummary(): {
  endpoint: string;
  region: string;
  mode: "localstack" | "aws";
} {
  return {
    endpoint: endpoint ?? "(default AWS endpoints)",
    region,
    mode: isLocalStack ? "localstack" : "aws",
  };
}
