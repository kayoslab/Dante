/** Agent integration page.
 *
 * With the Cognito-native design, Dante doesn't issue agent tokens
 * itself — agents (Vercel EVE etc.) authenticate against the Cognito
 * hosted UI via OAuth Authorization Code with PKCE and store the
 * resulting access + refresh tokens themselves. This page is purely
 * informational: it surfaces the OAuth endpoints + client ID + scope
 * catalog the operator needs to configure their EVE Connection, and
 * lists which scopes the signed-in user is actually permitted to
 * grant (gated by the Pre Token Generation Lambda).
 *
 * Revocation lives in three places, depending on the goal:
 *   - "Disconnect EVE specifically" → done in EVE (delete the stored
 *     refresh token there). Dante can't see EVE's vault.
 *   - "Nuclear: sign me out everywhere including the web UI" →
 *     /api/auth/signout from the top nav drops the local cookie;
 *     admin can additionally call AdminUserGlobalSignOut from the
 *     /settings/users page to invalidate refresh tokens server-side.
 *   - "Stop a specific compromised refresh token" → currently
 *     admin-side via the AWS console (RevokeToken). A self-service
 *     surface for this is on the roadmap once we have a forensic
 *     story for which refresh token corresponds to which device. */
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_SCOPES, callerMayMintScope } from "@/lib/auth/agent-scopes";
import { requireSession } from "@/lib/auth/session";

export const metadata = { title: "Agent integration — Dante" };

export default async function ProfileAgentsPage() {
  const ctx = await requireSession();

  const hosted_ui = process.env.COGNITO_HOSTED_UI_URL ?? "";
  const agent_client_id = process.env.COGNITO_AGENT_CLIENT_ID ?? "";
  const resource_server = "dante-agents";

  const allowed = (
    Object.entries(AGENT_SCOPES) as Array<
      [keyof typeof AGENT_SCOPES, (typeof AGENT_SCOPES)[keyof typeof AGENT_SCOPES]]
    >
  )
    .filter(([scope]) => callerMayMintScope(ctx.role, scope))
    .map(([scope, def]) => ({
      qualified: `${resource_server}/${scope}`,
      label: def.label,
      description: def.description,
    }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Agent integration
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure Vercel EVE (or any OAuth-aware agent framework) to
          call <code>/api/agent/*</code> on your behalf. Sign-in goes through
          Cognito with MFA, so the agent inherits Dante&rsquo;s account
          security automatically.
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          <Link href="/profile" className="underline hover:text-foreground">
            ← Back to profile
          </Link>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">OAuth endpoints</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <KV
            label="Authorize URL"
            value={`${hosted_ui}/oauth2/authorize`}
            mono
          />
          <KV label="Token URL" value={`${hosted_ui}/oauth2/token`} mono />
          <KV label="Client ID" value={agent_client_id} mono />
          <KV
            label="PKCE"
            value="Required (S256). The agent must generate a code_verifier per OAuth flow."
          />
          <KV
            label="Refresh"
            value="Supported — agent retains a refresh_token to mint new access tokens for the configured lifetime."
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Scopes you can grant ({allowed.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {allowed.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Your role doesn&rsquo;t permit any agent scopes yet.
            </p>
          ) : (
            <ul className="space-y-2 text-sm">
              {allowed.map((s) => (
                <li
                  key={s.qualified}
                  className="rounded-md border bg-background px-3 py-2"
                >
                  <div className="font-medium">
                    {s.label}{" "}
                    <code className="ml-1 text-xs text-muted-foreground">
                      {s.qualified}
                    </code>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {s.description}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            When the agent requests a wider scope set than your role permits,
            the Pre Token Generation Lambda drops the extras — the issued
            access token only carries what you&rsquo;re allowed to grant.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revoking access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Three options depending on what you want to revoke:
          </p>
          <ul className="ml-5 list-disc space-y-1.5">
            <li>
              <strong>Disconnect EVE specifically:</strong> delete the stored
              connection in EVE&rsquo;s settings. Dante can&rsquo;t see
              EVE&rsquo;s credential vault.
            </li>
            <li>
              <strong>Sign out the web UI everywhere:</strong> use the
              sign-out link in the top nav.
            </li>
            <li>
              <strong>Kill every active session (web + agent):</strong> ask an
              administrator to call AdminUserGlobalSignOut from
              /settings/users. This invalidates all your refresh tokens
              server-side and any cached access token will fail its next
              refresh.
            </li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <div className="w-32 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={
          mono
            ? "flex-1 overflow-x-auto rounded bg-muted/40 px-2 py-1 font-mono text-xs"
            : "flex-1 text-sm"
        }
      >
        {value || <span className="text-muted-foreground">— not configured —</span>}
      </div>
    </div>
  );
}
