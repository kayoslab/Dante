import type { NextAuthConfig } from "next-auth";
import Cognito from "next-auth/providers/cognito";
import Credentials from "next-auth/providers/credentials";

import { findOrCreateAppUser } from "./users";

/** App-level role derived from Cognito groups (or the dev override list).
 * The three groups are mutually exclusive in practice — if a user is in
 * more than one, the most-privileged wins. */
export type Role = "admin" | "manager" | "employee";

declare module "next-auth" {
  /** Surfaces the role + the linked employee_id on `session.user` so every
   * server-rendered page + Server Action can branch on it. MFA is
   * enforced upstream by Cognito's hosted UI (`mfa_configuration = "ON"`),
   * so there's no app-side MFA state on the session. */
  interface Session {
    user: {
      user_id: string;
      email: string;
      role: Role;
      employee_id: number | null;
    };
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    user_id: string;
    email: string;
    role: Role;
    employee_id: number | null;
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
        }),
      ],

  callbacks: {
    async jwt({ token, user, profile }) {
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
          const u = await findOrCreateAppUser({ email, cognito_sub: sub });
          token.user_id = u.user_id;
          token.email = u.email;
          token.employee_id = u.employee_id;
          token.role = cognitoRoleFor(groups);
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
      };
      return session;
    },
  },

  trustHost: true,
} satisfies NextAuthConfig;
