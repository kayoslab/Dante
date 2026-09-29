import Link from "next/link";
import { forbidden } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { getAworkAuthStatus } from "@/lib/integrations/providers/awork/auth";

export const metadata = { title: "awork integration — Dante" };

// Don't cache; the status reflects whatever's currently in the secret
// store and rotates with every sync.
export const dynamic = "force-dynamic";

const ERROR_MESSAGES: Record<string, string> = {
  missing_params: "awork didn't send back a code. Try authorizing again.",
  missing_cookie: "The authorization session expired before you returned. Try again.",
  bad_cookie: "The authorization session was malformed. Try again.",
  state_mismatch: "State mismatch — likely a stale tab. Try again from this page.",
  exchange_failed:
    "Couldn't exchange the authorization code for tokens. Check the dev server logs.",
  awork_access_denied: "You denied access on the awork screen. No changes were made.",
};

export default async function AworkIntegrationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  const { error: errorSlug, ok } = await searchParams;
  const status = await getAworkAuthStatus();

  await audit(ctx, {
    action: "view_awork_integration",
    target_type: "integration",
    target_id: "awork",
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">awork integration</h1>
        <p className="text-sm text-muted-foreground">
          The sync uses an OAuth refresh token that expires after 30 days of
          inactivity. Re-authorize here when it does, before the next sync run.
        </p>
      </div>

      {ok && (
        <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          awork re-authorized successfully. Token will be used on the next sync.
        </div>
      )}
      {errorSlug && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {ERROR_MESSAGES[errorSlug] ?? `Authorization failed (${errorSlug}).`}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent>
          <StatusRow status={status} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Re-authorize</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            Click below to start the OAuth flow. You&rsquo;ll be redirected to{" "}
            <code>awork.com</code>, asked to approve, and bounced back here.
          </p>
          <p className="text-xs text-muted-foreground">
            Redirect URI registered on awork side must include:{" "}
            <code>/auth/awork/callback</code>
          </p>
          <Link
            href="/auth/awork/start"
            className={buttonVariants({ size: "sm" })}
          >
            Authorize awork
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusRow({
  status,
}: {
  status: Awaited<ReturnType<typeof getAworkAuthStatus>>;
}) {
  if (status.state === "missing_client") {
    return (
      <div className="space-y-1 text-sm">
        <Badge variant="destructive">Not configured</Badge>
        <p className="text-muted-foreground">{status.reason}</p>
      </div>
    );
  }
  if (status.state === "no_tokens") {
    return (
      <div className="space-y-1 text-sm">
        <Badge variant="secondary">Not authorized</Badge>
        <p className="text-muted-foreground">
          No awork tokens on file. Authorize below to enable the sync.
        </p>
      </div>
    );
  }
  const when = new Date(status.expires_at * 1000);
  return (
    <div className="space-y-1 text-sm">
      <Badge variant={status.is_expired ? "destructive" : "secondary"}>
        {status.is_expired ? "Expired" : "Authorized"}
      </Badge>
      <p className="tabular-nums text-muted-foreground">
        Access token {status.is_expired ? "expired" : "expires"} at{" "}
        {when.toLocaleString("de-DE")}
      </p>
    </div>
  );
}
