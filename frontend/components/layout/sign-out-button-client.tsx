"use client";

import { signOut } from "next-auth/react";

/** Client Component — clears the Auth.js cookie via `next-auth/react`'s
 * client signOut (which does a fetch to /api/auth/signout), then sets
 * window.location to the Cognito /logout URL. `window.location` is the
 * only reliable way to force a top-level navigation to an external host
 * across all browsers and Next.js variants. */
export function SignOutButtonClient({
  cognitoLogoutUrl,
}: {
  cognitoLogoutUrl: string | null;
}) {
  async function handleClick() {
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
