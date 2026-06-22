"use client";

import { signOut } from "next-auth/react";

import { revokeCognitoTokenAction } from "@/lib/actions/auth";

/** Client Component — runs the sign-out sequence in order:
 *
 *   1. `revokeCognitoTokenAction()` — calls Cognito's RevokeToken with
 *      the refresh token so it stops working immediately (otherwise it
 *      stays valid for up to 7 days even after sign-out). Best effort:
 *      a failure here doesn't block the rest.
 *   2. `signOut({ redirect: false })` — clears the Auth.js session
 *      cookie via /api/auth/signout.
 *   3. `window.location = <Cognito /logout>` — top-level navigation
 *      that kills the IdP session cookie on `auth.<domain>` and
 *      bounces back to the app's `/login`.
 *
 * `window.location` is the only reliable way to force a top-level
 * navigation to an external host across all browsers and Next.js
 * variants. */
export function SignOutButtonClient({
  cognitoLogoutUrl,
}: {
  cognitoLogoutUrl: string | null;
}) {
  async function handleClick() {
    await revokeCognitoTokenAction();
    await signOut({ redirect: false });
    window.location.href = cognitoLogoutUrl ?? "/login";
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:border-foreground transition"
    >
      Sign out
    </button>
  );
}
