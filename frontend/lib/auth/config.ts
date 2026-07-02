import type { NextAuthConfig } from "next-auth";
import Cognito from "next-auth/providers/cognito";
import Credentials from "next-auth/providers/credentials";

import { hasStrongFactorWithToken } from "./cognito-self-service";
import { findOrCreateAppUser } from "./users";

/** App-level role derived from Cognito groups (or the dev override list).
 * The three groups are mutually exclusive in practice — if a user is in
 * more than one, the most-privileged wins. */
export type Role = "admin" | "manager" | "employee";

declare module "next-auth" {
  /** Surfaces the role + the linked employee_id on `session.user` so every
   * server-rendered page + Server Action can branch on it. When passkeys
   * are enabled the pool is on mfa=OPTIONAL, so `has_strong_factor` carries
   * the app-side MFA gate state (passkey or TOTP present); in the ON-mode
   * default it's always true (Cognito enforces MFA upstream). */
  interface Session {
    user: {
      user_id: string;
      email: string;
      role: Role;
      employee_id: number | null;
      has_strong_factor: boolean;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    user_id: string;
    email: string;
    role: Role;
    employee_id: number | null;
    /** OAuth tokens from Cognito. Stored on the JWT so server actions can
     * call Cognito's self-service APIs (ChangePassword, TOTP setup, etc.)
     * on behalf of the user. Read server-side only — NEVER surface these
     * via the session callback; XSS that reaches /api/auth/session must
     * not pick them up. */
    cognito_access_token?: string;
    cognito_refresh_token?: string;
    /** Unix seconds. Used to refresh proactively a few seconds before
     * Cognito would reject the access token. */
    cognito_access_expires_at?: number;
    /** Set when the refresh-token exchange returns 4xx — the user must
     * re-sign-in for any Cognito SDK call. The session itself stays
     * usable for app-side reads until the JWT cookie expires. */
    cognito_refresh_failed?: boolean;
    /** Whether the user has ≥1 strong factor (passkey or TOTP). Only
     * meaningful when passkeys are enabled (pool on mfa=OPTIONAL);
     * computed in the jwt callback at sign-in / refresh / update. Read by
     * `requireSession()` to gate users with no factor to /security/setup.
     * `undefined` in passkeys-off mode (gate inert). */
    has_strong_factor?: boolean;
  }
}

const isDevMode = process.env.AUTH_DEV_MODE === "true";

// Hard guard: dev mode + prod is total auth bypass. Fail at module init
// rather than serve a single request with credential auth open. A typo
// in the ECS task definition env vars is the realistic threat model
// here — the assertion catches it before the LB ever marks the task
// healthy.
if (isDevMode && process.env.NODE_ENV === "production") {
  throw new Error(
    "AUTH_DEV_MODE=true is incompatible with NODE_ENV=production. " +
      "Dev mode accepts any password and must never reach prod. " +
      "Unset AUTH_DEV_MODE on the prod task definition.",
  );
}

/** Parse a comma-separated env var into a lowercased set. */
function envEmailSet(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

const devAdminEmails = envEmailSet("AUTH_DEV_ADMIN_EMAILS");
const devManagerEmails = envEmailSet("AUTH_DEV_MANAGER_EMAILS");

function devRoleFor(email: string): Role {
  const e = email.toLowerCase();
  if (devAdminEmails.has(e)) return "admin";
  if (devManagerEmails.has(e)) return "manager";
  return "employee";
}

/** Pick the highest-privilege role from a Cognito groups claim. */
function cognitoRoleFor(groups: string[] | undefined): Role {
  if (!groups) return "employee";
  if (groups.includes("admin")) return "admin";
  if (groups.includes("manager")) return "manager";
  return "employee";
}

/** Exchange the stored refresh token for a fresh access token. Returns
 * null if Cognito rejects the refresh (revoked, expired, or pool config
 * changed) — caller flips `cognito_refresh_failed` and the user is
 * prompted to re-sign-in on the next Cognito API call. */
async function refreshCognitoAccessToken(
  refresh_token: string,
): Promise<{ access_token: string; expires_at: number } | null> {
  const issuer = process.env.COGNITO_ISSUER;
  const clientId = process.env.COGNITO_CLIENT_ID;
  const clientSecret = process.env.COGNITO_CLIENT_SECRET;
  if (!issuer || !clientId) return null;
  const tokenEndpoint = `${issuer.replace(/\/$/, "")}/oauth2/token`;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  // Confidential app clients (the prod default) require HTTP Basic auth
  // with the client_id:client_secret pair. Public clients skip this.
  if (clientSecret) {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    headers.Authorization = `Basic ${basic}`;
  }
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token,
  }).toString();
  try {
    const res = await fetch(tokenEndpoint, { method: "POST", headers, body });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    return {
      access_token: data.access_token,
      expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
    };
  } catch {
    return null;
  }
}

export const authConfig = {
  // JWT session strategy — no DB sessions table needed. The Cognito tokens
  // (or the dev-mode equivalent) get encoded into an encrypted cookie that
  // Auth.js manages.
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 7 /* 7d */ },

  pages: {
    signIn: "/login",
  },

  providers: isDevMode
    ? [
        // Dev-only Credentials provider. Any password works — the dev mode
        // exists so we can iterate on the UI without provisioning AWS yet.
        // Roles come from AUTH_DEV_ADMIN_EMAILS / AUTH_DEV_MANAGER_EMAILS.
        // NEVER enable AUTH_DEV_MODE in production.
        Credentials({
          id: "dev",
          name: "Dev sign-in",
          credentials: {
            email: { label: "Email", type: "email" },
          },
          async authorize(input) {
            const email =
              typeof input?.email === "string" ? input.email.trim() : "";
            if (!email) return null;
            // On first sign-in, seed the role from env vars (so the first
            // admin can sign in without manual DB tweaks). On subsequent
            // sign-ins the DB row's role takes precedence — env var changes
            // do NOT override existing users' roles.
            const seeded_role = devRoleFor(email);
            const user = await findOrCreateAppUser({
              email,
              cognito_sub: `dev:${email.toLowerCase()}`,
            });
            // If the row was just created (no last_login for it yet), the
            // expected_role would have been seeded above. Otherwise stick
            // with what's in the DB so admin role-changes from
            // /settings/users actually take effect.
            const role = user.role ?? seeded_role;
            if (user.is_disabled) return null;
            return {
              id: user.user_id,
              email: user.email,
              user_id: user.user_id,
              employee_id: user.employee_id,
              role,
            };
          },
        }),
      ]
    : [
        Cognito({
          clientId: process.env.COGNITO_CLIENT_ID,
          clientSecret: process.env.COGNITO_CLIENT_SECRET,
          issuer: process.env.COGNITO_ISSUER,
          // Explicitly request `aws.cognito.signin.user.admin` so the
          // access token can call the user-scoped cognito-idp APIs
          // (ChangePassword, AssociateSoftwareToken, VerifySoftwareToken,
          // SetUserMFAPreference) used by `/profile` self-service.
          // Auth.js's default Cognito provider asks only
          // `openid profile email`; without this override, every /profile
          // request hits `NotAuthorizedException: Access Token does not
          // have required scopes`. The same scope must also be in the
          // user-pool client's `allowed_oauth_scopes` (see
          // terraform/modules/cognito).
          authorization: {
            params: {
              scope: "openid profile email aws.cognito.signin.user.admin",
            },
          },
        }),
      ],

  callbacks: {
    async jwt({ token, user, profile, account, trigger }) {
      // On sign-in, hydrate the token with our app's user record + role.
      // `user` is populated only on the initial authorize() call.
      if (user) {
        token.user_id = (user as { user_id?: string }).user_id ?? token.user_id;
        token.email = user.email ?? token.email;
        token.role = (user as { role?: Role }).role ?? token.role ?? "employee";
        token.employee_id =
          (user as { employee_id?: number | null }).employee_id ??
          token.employee_id ??
          null;
      }
      // On Cognito sign-in, profile carries `cognito:groups`. Cognito's
      // hosted UI enforces MFA before the OIDC code is issued
      // (`mfa_configuration = "ON"` on the user pool), so by the time
      // we see a token, MFA has already happened. No app-side gate.
      if (profile) {
        const groups =
          (profile as { "cognito:groups"?: string[] })["cognito:groups"] ?? [];
        const sub = (profile as { sub?: string }).sub;
        const email = (profile as { email?: string }).email;
        if (sub && email) {
          const expected_role = cognitoRoleFor(groups);
          // Pass `expected_role` so findOrCreateAppUser writes the Cognito
          // groups → app_user.role on every sign-in. Without this the DB
          // column drifts behind Cognito after a role change, and admin
          // actions that gate on app_user.role would treat a freshly-
          // demoted user as still admin until the next manual write.
          const u = await findOrCreateAppUser({
            email,
            cognito_sub: sub,
            expected_role,
          });
          token.user_id = u.user_id;
          token.email = u.email;
          token.employee_id = u.employee_id;
          token.role = expected_role;
        }
      }
      // Capture Cognito OAuth tokens on initial sign-in. Server actions
      // in `lib/auth/cognito-self-service.ts` use the access token to
      // call ChangePassword / TOTP / SetUserMFAPreference on the
      // signed-in user's behalf.
      if (account?.provider === "cognito") {
        token.cognito_access_token = account.access_token;
        token.cognito_refresh_token = account.refresh_token;
        token.cognito_access_expires_at = account.expires_at;
        token.cognito_refresh_failed = false;
      }
      // Proactive refresh — Cognito access tokens last 60min by default.
      // We refresh 30s early to avoid the access-token-just-expired race
      // when the SDK call lands on Cognito after we've decided the token
      // is fresh. If the refresh fails, mark the flag so the SDK wrapper
      // can prompt the user to re-sign-in instead of replaying a
      // permanently-rejected refresh on every request.
      const now = Math.floor(Date.now() / 1000);
      let refreshedNow = false;
      if (
        token.cognito_refresh_token &&
        token.cognito_access_expires_at &&
        !token.cognito_refresh_failed &&
        now > token.cognito_access_expires_at - 30
      ) {
        const refreshed = await refreshCognitoAccessToken(
          token.cognito_refresh_token,
        );
        if (refreshed) {
          token.cognito_access_token = refreshed.access_token;
          token.cognito_access_expires_at = refreshed.expires_at;
          refreshedNow = true;
        } else {
          token.cognito_refresh_failed = true;
        }
      }

      // Strong-factor flag for the app-side MFA gate. Only when passkeys
      // are enabled (pool on mfa=OPTIONAL) — in the ON-mode default,
      // Cognito already forces TOTP for everyone, so the gate is inert
      // and we leave the flag true.
      //
      // Compute against Cognito ONLY at moments the factor set can have
      // changed — sign-in (account/profile), an explicit session
      // `update()` after enrollment, a token refresh, or the first time
      // the flag is unset. NOT on every request (the jwt callback runs
      // per request that reads the session; an unconditional call would
      // be a Cognito round-trip on every navigation).
      if (process.env.DANTE_PASSKEYS_ENABLED !== "true") {
        token.has_strong_factor = true;
      } else if (
        token.cognito_access_token &&
        !token.cognito_refresh_failed &&
        // Recompute at sign-in / refresh / explicit update, OR whenever
        // the flag isn't already true. The `!== true` clause means a
        // factorless user re-checks on every request (they're pinned to
        // /security/setup anyway, so it's a few calls) and the moment
        // they enrol a factor the next request flips the flag true — no
        // client-side session `update()` needed. Once true, only the
        // sign-in / refresh / update triggers recompute, so a normal
        // user pays no per-request Cognito call.
        (account ||
          profile ||
          trigger === "update" ||
          refreshedNow ||
          token.has_strong_factor !== true)
      ) {
        try {
          token.has_strong_factor = await hasStrongFactorWithToken(
            token.cognito_access_token,
          );
        } catch {
          // Don't lock the user out on a transient Cognito error — keep
          // the prior value, defaulting to true (fail-open on the gate,
          // fail-closed is worse here: a Cognito blip would bounce every
          // user to /security/setup mid-session).
          token.has_strong_factor = token.has_strong_factor ?? true;
        }
      }
      return token;
    },

    async session({ session, token }) {
      // AdapterUser (the wider Auth.js Session shape) requires `id` and
      // `emailVerified`. We're JWT-only so those don't fill themselves —
      // keep them in sync with the JWT-derived values.
      session.user = {
        ...session.user,
        id: token.user_id,
        user_id: token.user_id,
        email: token.email,
        role: token.role,
        employee_id: token.employee_id,
        // Non-sensitive boolean — safe to surface (unlike the Cognito
        // tokens). requireSession() reads it to gate factorless users.
        has_strong_factor: token.has_strong_factor ?? true,
      };
      return session;
    },
  },

  trustHost: true,
} satisfies NextAuthConfig;
