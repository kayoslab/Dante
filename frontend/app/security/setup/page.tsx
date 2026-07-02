import { redirect } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth/session";
import { hasCognitoSession } from "@/lib/auth/cognito-tokens";
import { safeCallback } from "@/lib/auth/redirects";
import { listPasskeys } from "@/lib/auth/cognito-self-service";

import { SetupFactorCard } from "./setup-client";

export const metadata = { title: "Set up 2-step sign-in — Dante" };

/** Forced strong-factor enrollment.
 *
 * `requireSession()` redirects here whenever a signed-in user has neither
 * a passkey nor TOTP (only possible when passkeys are enabled → pool on
 * mfa=OPTIONAL, so Cognito no longer forces a factor). This page is the
 * one surface that opts OUT of that gate (`allowMissingFactor`), so the
 * user isn't bounced in a loop. Once they enrol a factor, the next
 * request's jwt callback flips `has_strong_factor` true and they flow on. */
export default async function SecuritySetupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const ctx = await requireSession({ allowMissingFactor: true });
  const { next } = await searchParams;
  const dest = safeCallback(next);

  // Dev mode (no Cognito session) has no factor concept — never gate.
  // A user who already has a factor shouldn't linger here.
  if (!(await hasCognitoSession()) || ctx.has_strong_factor) {
    redirect(dest);
  }

  // Surface any already-registered passkeys (e.g. they added one but the
  // page reloaded) so the UI is accurate.
  const passkeys = await listPasskeys().catch(() => []);

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-lg flex-col justify-center gap-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">
          Secure your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Before you continue, set up a second step for signing in. Add a
          passkey (recommended) or an authenticator app — you only need one.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Choose a method</CardTitle>
        </CardHeader>
        <CardContent>
          <SetupFactorCard
            initialPasskeys={passkeys}
            redirectTo={dest}
            email={ctx.email}
          />
        </CardContent>
      </Card>
    </div>
  );
}
