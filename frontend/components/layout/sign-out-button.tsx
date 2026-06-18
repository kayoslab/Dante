import { SignOutButtonClient } from "./sign-out-button-client";

/** Server Component — reads the Cognito hosted-UI env vars and hands the
 * composed logout URL to the client. The client component handles the
 * actual navigation because server-action redirects to external hosts
 * are unreliable in Auth.js v5 + Next.js (the redirect is returned as
 * a same-origin navigation in the RSC payload, never reaches Cognito).
 *
 * Cognito's /logout endpoint clears its IdP-side session cookie and
 * bounces the browser to logout_uri (must be in the user-pool client's
 * allowed `logout_urls`). Without this bounce, signing out of the app
 * only clears the Auth.js cookie — Cognito still considers the user
 * signed in, so the next click on "Sign in" silently re-issues an
 * OAuth code without prompting for credentials. */
export function SignOutButton() {
  const hostedUi = process.env.COGNITO_HOSTED_UI_URL;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const appUrl = process.env.NEXTAUTH_URL;
  const cognitoLogoutUrl =
    hostedUi && clientId && appUrl
      ? `${hostedUi}/logout?client_id=${clientId}&logout_uri=${encodeURIComponent(appUrl)}`
      : null;
  return <SignOutButtonClient cognitoLogoutUrl={cognitoLogoutUrl} />;
}
