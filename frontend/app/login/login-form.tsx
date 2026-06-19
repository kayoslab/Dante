"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeCallback } from "@/lib/auth/redirects";

export function LoginForm({
  callbackUrl,
  devMode,
  cognitoEnabled,
}: {
  callbackUrl: string;
  devMode: boolean;
  cognitoEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState<"dev" | "cognito" | null>(null);

  // Defense in depth: the page already validates, but re-validating here
  // means a future caller that wires `callbackUrl` from elsewhere can't
  // accidentally introduce the open-redirect.
  const safeRedirect = safeCallback(callbackUrl);

  async function onCredentials(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting("dev");
    // The dev provider's id is "dev" (see lib/auth/config.ts). signIn redirects
    // on success; on failure it appends ?error=CredentialsSignin to the URL.
    await signIn("dev", {
      email,
      password,
      redirectTo: safeRedirect,
    });
    setSubmitting(null);
  }

  async function onCognito() {
    setSubmitting("cognito");
    await signIn("cognito", { redirectTo: safeRedirect });
    setSubmitting(null);
  }

  return (
    <div className="space-y-4">
      {devMode ? (
        <form onSubmit={onCredentials} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="(any value works in dev mode)"
            />
          </div>
          <Button type="submit" className="w-full" disabled={!!submitting}>
            {submitting === "dev" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : null}
            Sign in
          </Button>
        </form>
      ) : null}

      {cognitoEnabled && (
        <>
          {devMode && (
            <div className="flex items-center gap-3 py-1">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs uppercase tracking-wider text-muted-foreground">
                or
              </span>
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={!!submitting}
            onClick={onCognito}
          >
            {submitting === "cognito" ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : null}
            Continue with single sign-on
          </Button>
        </>
      )}
    </div>
  );
}
