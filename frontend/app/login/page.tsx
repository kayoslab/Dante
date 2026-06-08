import { redirect } from "next/navigation";

import { getSession } from "@/lib/auth/session";

import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in — Dante" };

const DEV_MODE = process.env.AUTH_DEV_MODE === "true";
const COGNITO_ENABLED =
  !DEV_MODE && process.env.COGNITO_CLIENT_ID !== undefined;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await getSession();
  const { callbackUrl, error } = await searchParams;
  if (session) redirect(callbackUrl ?? "/");

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-sm flex-col justify-center gap-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Dante</h1>
        <p className="text-sm text-muted-foreground">
          Sign in to continue.
        </p>
      </div>

      <figure className="mx-auto max-w-xs text-center">
        <blockquote className="font-serif text-sm italic text-muted-foreground">
          &ldquo;Lasciate ogne speranza, voi ch&rsquo;intrate.&rdquo;
        </blockquote>
        <figcaption className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          Inferno · Canto III
        </figcaption>
      </figure>

      {DEV_MODE && (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong>Dev mode:</strong> any password works. Role comes from{" "}
          <code>AUTH_DEV_ADMIN_EMAILS</code> /{" "}
          <code>AUTH_DEV_MANAGER_EMAILS</code> in <code>.env</code>.
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
          {error === "CredentialsSignin"
            ? "Sign-in failed. Check the email and try again."
            : `Sign-in failed: ${error}`}
        </div>
      )}

      <LoginForm
        callbackUrl={callbackUrl ?? "/"}
        devMode={DEV_MODE}
        cognitoEnabled={COGNITO_ENABLED}
      />
    </div>
  );
}
