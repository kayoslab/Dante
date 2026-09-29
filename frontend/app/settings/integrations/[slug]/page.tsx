import Link from "next/link";
import { headers } from "next/headers";
import { forbidden, notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CredentialForm } from "@/components/settings/credential-form";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { getIntegration } from "@/lib/db/queries/integration";
import { oauthStatus } from "@/lib/integrations/core/credentials";
import { getAdapter } from "@/lib/integrations/core/registry";
import { getSecretStore } from "@/lib/integrations/core/secret-store";

import { CredentialStateBadge, formatWhen } from "../_status";

export const metadata = { title: "Integration — Dante" };

export const dynamic = "force-dynamic";

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_params: "The provider didn't send back a code. Try authorizing again.",
  missing_cookie: "The authorization session expired before you returned. Try again.",
  bad_cookie: "The authorization session was malformed. Try again.",
  state_mismatch: "State mismatch — likely a stale tab. Try again from this page.",
  exchange_failed: "Couldn't exchange the authorization code for tokens. Check the server logs.",
  awork_access_denied: "You denied access on the provider's screen. No changes were made.",
};

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  const { slug } = await params;
  const { error: errorSlug, ok } = await searchParams;

  const row = await getIntegration(slug);
  if (!row) notFound();
  const adapter = getAdapter(row.provider);
  if (!adapter) notFound();

  await audit(ctx, { action: "view_integration", target_type: "integration", target_id: slug });

  const store = getSecretStore();
  const isOAuth = adapter.auth.kind === "oauth2_pkce";
  const oauth = isOAuth
    ? await oauthStatus(
        slug,
        adapter.auth.fields.filter((f) => f.required).map((f) => f.key),
      )
    : null;

  // The callback URL the OAuth client must be registered with. Behind the
  // ALB the request origin is the task's internal address, so the public
  // origin wins when configured.
  let redirectUri: string | null = null;
  if (isOAuth) {
    const h = await headers();
    const proto = h.get("x-forwarded-proto") ?? "http";
    const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
    const origin = process.env.NEXTAUTH_URL ?? `${proto}://${host}`;
    redirectUri = new URL(`/auth/${slug}/callback`, origin).toString();
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/settings/integrations" className="text-sm text-muted-foreground hover:underline">
          ← Integrations
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{row.display_name}</h1>
        <p className="text-sm text-muted-foreground">
          {adapter.displayName} adapter · provides {adapter.capabilities.join(", ")}
          {adapter.docsUrl && (
            <>
              {" "}
              ·{" "}
              <a href={adapter.docsUrl} className="underline" target="_blank" rel="noreferrer">
                API docs
              </a>
            </>
          )}
        </p>
      </div>

      {ok && (
        <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Authorized successfully. The new tokens are used on the next sync.
        </div>
      )}
      {errorSlug && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {OAUTH_ERROR_MESSAGES[errorSlug] ?? `Authorization failed (${errorSlug}).`}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={row.enabled ? "secondary" : "outline"}>
              {row.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <CredentialStateBadge state={row.credential_state} />
            {oauth && (
              <Badge
                variant={
                  oauth.state === "authorized" && !oauth.is_expired ? "secondary" : "destructive"
                }
              >
                {oauth.state === "missing_client"
                  ? "OAuth client not configured"
                  : oauth.state === "no_tokens"
                    ? "Not authorized"
                    : oauth.is_expired
                      ? "Token expired"
                      : "Authorized"}
              </Badge>
            )}
          </div>
          <dl className="grid gap-1 text-muted-foreground sm:grid-cols-[10rem_1fr]">
            <dt>Credentials</dt>
            <dd>
              {row.credential_state === "set" || row.credential_state === "invalid"
                ? `set ${formatWhen(row.credential_set_at)} by ${row.credential_set_by ?? "—"}`
                : row.credential_state === "external"
                  ? `managed outside Dante (${store.kind} store)`
                  : "not set"}
            </dd>
            {oauth?.state === "authorized" && (
              <>
                <dt>Access token</dt>
                <dd className="tabular-nums">
                  {oauth.is_expired ? "expired" : "expires"}{" "}
                  {new Date(oauth.expires_at * 1000).toLocaleString("de-DE")}
                </dd>
              </>
            )}
            <dt>Last sync</dt>
            <dd>
              {row.last_sync_at ? formatWhen(row.last_sync_at) : "never"}
              {row.last_sync_status ? ` · ${row.last_sync_status}` : ""}
            </dd>
            {row.last_error && (
              <>
                <dt>Last error</dt>
                <dd className="whitespace-pre-wrap font-mono text-xs text-red-700">{row.last_error}</dd>
              </>
            )}
          </dl>
          <TestConnectionButton slug={slug} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{isOAuth ? "OAuth client" : "Credentials"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Stored write-only in the {store.kind} secret store: values are never shown again
            after saving. Saving replaces the whole set.
          </p>
          <CredentialForm
            slug={slug}
            fields={adapter.auth.fields}
            writable={store.writable}
            storeHint={store.describe()}
          />
        </CardContent>
      </Card>

      {isOAuth && (
        <Card>
          <CardHeader>
            <CardTitle>Authorize</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>
              Start the OAuth flow: you&rsquo;ll be sent to the provider, asked to approve, and
              brought back here. The refresh token expires after a period of inactivity; re-authorize
              when the status above says so.
            </p>
            <p className="text-xs text-muted-foreground">
              Redirect URI to register on the provider side:{" "}
              <code className="rounded bg-muted px-1">{redirectUri}</code>
            </p>
            <Link href={`/auth/${slug}/start`} className={buttonVariants({ size: "sm" })}>
              Authorize {row.display_name}
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
