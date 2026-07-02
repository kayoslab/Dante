"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Fingerprint, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  completePasskeyEnrollmentAction,
  confirmTotpEnrollmentAction,
  startPasskeyEnrollmentAction,
  startTotpEnrollmentAction,
} from "@/lib/actions/profile";
import { isPasskeySupported, registerPasskey } from "@/lib/webauthn/browser";
import type { PasskeyRow } from "@/components/profile/security-card";

/** Compact enrollment surface for the forced /security/setup gate. Offers
 * passkey (primary) + TOTP; on success it navigates to `redirectTo`,
 * where the next request's jwt callback flips `has_strong_factor` true
 * and requireSession lets the user through. */
export function SetupFactorCard({
  initialPasskeys,
  redirectTo,
  email,
}: {
  initialPasskeys: PasskeyRow[];
  redirectTo: string;
  email: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const supported = typeof window === "undefined" ? true : isPasskeySupported();

  const done = () => {
    // Full navigation so the JWT is re-read server-side and the gate
    // re-evaluates with the freshly-enrolled factor.
    router.replace(redirectTo);
    router.refresh();
  };

  const addPasskey = () =>
    startTransition(async () => {
      const started = await startPasskeyEnrollmentAction();
      if (!started.ok) { toast.error(started.error.detail); return; }
      let credential: Record<string, unknown>;
      try {
        credential = await registerPasskey(started.data.options);
      } catch (e) {
        { toast.error(
          e instanceof Error ? e.message : "Passkey setup failed.",
        ); return; }
      }
      const res = await completePasskeyEnrollmentAction({ credential });
      if (!res.ok) { toast.error(res.error.detail); return; }
      toast.success("Passkey added.");
      done();
    });

  // TOTP inline setup
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const startTotp = () =>
    startTransition(async () => {
      const r = await startTotpEnrollmentAction();
      if (!r.ok) { toast.error(r.error.detail); return; }
      setSecret(r.data.secret);
      setOtpauthUrl(r.data.otpauth_url);
    });

  const confirmTotp = () =>
    startTransition(async () => {
      const r = await confirmTotpEnrollmentAction({ code });
      if (!r.ok) { toast.error(r.error.detail); return; }
      toast.success("Authenticator enabled.");
      done();
    });

  if (initialPasskeys.length > 0) {
    // Belt and braces — a factor already exists; just let them proceed.
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          You already have a passkey registered.
        </p>
        <Button onClick={done}>Continue</Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Passkey */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Passkey (recommended)</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Use your device&rsquo;s biometrics or PIN. Phishing-resistant and the
          fastest way to sign in next time.
        </p>
        {supported ? (
          <Button onClick={addPasskey} disabled={isPending}>
            {isPending ? "Working…" : "Add a passkey"}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">
            This device doesn&rsquo;t support passkeys — use an authenticator
            app below.
          </p>
        )}
      </section>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
        <div className="h-px flex-1 bg-border" />
        or
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* TOTP */}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Authenticator app</h3>
        </div>
        {!secret ? (
          <Button variant="outline" onClick={startTotp} disabled={isPending}>
            Set up authenticator
          </Button>
        ) : (
          <div className="space-y-3 rounded-md border bg-muted/20 p-4">
            <p className="text-sm">
              Scan the QR in your app, or paste this secret ({email}):
            </p>
            <div className="rounded bg-background px-2 py-1 font-mono text-xs">
              {secret}
            </div>
            {otpauthUrl && (
              <a
                href={otpauthUrl}
                className="text-xs text-muted-foreground underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Open otpauth:// link
              </a>
            )}
            <div className="grid max-w-xs gap-2">
              <Label htmlFor="totp_code">Code from the app</Label>
              <Input
                id="totp_code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
              />
              <Button
                onClick={confirmTotp}
                disabled={isPending || code.length !== 6}
              >
                {isPending ? "Verifying…" : "Verify & enable"}
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
