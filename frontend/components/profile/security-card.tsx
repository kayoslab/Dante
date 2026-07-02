"use client";

import { useState, useTransition } from "react";
import { Fingerprint, KeyRound, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changePasswordAction,
  completePasskeyEnrollmentAction,
  confirmTotpEnrollmentAction,
  deletePasskeyAction,
  listPasskeysAction,
  startPasskeyEnrollmentAction,
  startTotpEnrollmentAction,
} from "@/lib/actions/profile";
import { isPasskeySupported, registerPasskey } from "@/lib/webauthn/browser";

export type PasskeyRow = {
  credential_id: string;
  friendly_name: string | null;
  created_at: string | null;
};

export function SecurityCard({
  initialTotpEnabled,
  initialPasskeys,
}: {
  initialTotpEnabled: boolean;
  initialPasskeys: PasskeyRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" />
          Account security
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-8">
        <PasswordSection />
        <PasskeySection initialPasskeys={initialPasskeys} />
        <TotpSection initialEnabled={initialTotpEnabled} />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isPending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== confirm) {
      toast.error("New password fields don't match.");
      return;
    }
    startTransition(async () => {
      const r = await changePasswordAction({
        current_password: current,
        new_password: next,
      });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Password changed.");
      setCurrent("");
      setNext("");
      setConfirm("");
    });
  };

  return (
    <section className="space-y-3">
      <header className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Password</h3>
      </header>
      <form
        onSubmit={onSubmit}
        className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <div className="sm:col-span-2">
          <Label htmlFor="current_password">Current password</Label>
          <Input
            id="current_password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="new_password">New password</Label>
          <Input
            id="new_password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            minLength={8}
            required
          />
        </div>
        <div>
          <Label htmlFor="confirm_password">Confirm new password</Label>
          <Input
            id="confirm_password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" disabled={isPending || !current || !next}>
            {isPending ? "Changing…" : "Change password"}
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Passkeys (WebAuthn)
// ---------------------------------------------------------------------------

function PasskeySection({ initialPasskeys }: { initialPasskeys: PasskeyRow[] }) {
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>(initialPasskeys);
  const [isPending, startTransition] = useTransition();
  // Feature-detect once on mount via a lazy initializer — SSR renders the
  // button optimistically, then the effect-free check corrects it on the
  // client. isPasskeySupported() is safe to call during render on the
  // client (it guards on typeof window).
  const supported = typeof window === "undefined" ? true : isPasskeySupported();

  const refresh = () =>
    startTransition(async () => {
      const r = await listPasskeysAction();
      if (r.ok) setPasskeys(r.data.passkeys);
    });

  const addPasskey = () =>
    startTransition(async () => {
      const started = await startPasskeyEnrollmentAction();
      if (!started.ok) {
        toast.error(started.error.detail);
        return;
      }
      let credential: Record<string, unknown>;
      try {
        credential = await registerPasskey(started.data.options);
      } catch (e) {
        // User cancelled the OS prompt, or the device refused — not a
        // server error, so surface the browser message directly.
        toast.error(e instanceof Error ? e.message : "Passkey setup failed.");
        return;
      }
      const done = await completePasskeyEnrollmentAction({ credential });
      if (!done.ok) {
        toast.error(done.error.detail);
        return;
      }
      toast.success("Passkey added.");
      const r = await listPasskeysAction();
      if (r.ok) setPasskeys(r.data.passkeys);
    });

  const removePasskey = (credential_id: string) =>
    startTransition(async () => {
      const r = await deletePasskeyAction({ credential_id });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Passkey removed.");
      setPasskeys((prev) =>
        prev.filter((p) => p.credential_id !== credential_id),
      );
    });

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Passkeys</h3>
        </div>
        {passkeys.length > 0 ? (
          <Badge variant="secondary">{passkeys.length} registered</Badge>
        ) : (
          <Badge variant="outline">none</Badge>
        )}
      </header>

      <p className="max-w-md text-sm text-muted-foreground">
        A passkey lets you sign in with your device&rsquo;s biometrics or PIN —
        no password and no authenticator code. It&rsquo;s phishing-resistant
        and the recommended way to sign in. You can keep your authenticator
        app as a backup.
      </p>

      {passkeys.length > 0 && (
        <ul className="max-w-md space-y-2">
          {passkeys.map((p) => (
            <li
              key={p.credential_id}
              className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">
                  {p.friendly_name || "Passkey"}
                </div>
                {p.created_at && (
                  <div className="text-xs text-muted-foreground tabular-nums">
                    added {p.created_at.slice(0, 10)}
                  </div>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removePasskey(p.credential_id)}
                disabled={isPending}
                title="Remove passkey"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {supported ? (
        <Button
          size="sm"
          variant="outline"
          onClick={addPasskey}
          disabled={isPending}
        >
          {isPending ? "Working…" : "Add a passkey"}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">
          This device doesn&rsquo;t support passkeys — use the authenticator app
          below instead.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// TOTP
// ---------------------------------------------------------------------------

function TotpSection({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [setupSecret, setSetupSecret] = useState<string | null>(null);
  const [setupQrUrl, setSetupQrUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [isPending, startTransition] = useTransition();

  const startEnroll = () =>
    startTransition(async () => {
      const r = await startTotpEnrollmentAction();
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      setSetupSecret(r.data.secret);
      setSetupQrUrl(r.data.otpauth_url);
    });

  const confirmEnroll = () =>
    startTransition(async () => {
      const r = await confirmTotpEnrollmentAction({ code });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Authenticator enabled.");
      setSetupSecret(null);
      setSetupQrUrl(null);
      setCode("");
      setEnabled(true);
    });


  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Authenticator app (TOTP)</h3>
        </div>
        {enabled ? (
          <Badge variant="secondary">enabled</Badge>
        ) : (
          <Badge variant="outline">not set up</Badge>
        )}
      </header>

      {!enabled && !setupSecret && (
        <div className="space-y-2">
          <p className="max-w-md text-sm text-muted-foreground">
            Scan a QR with Google Authenticator, 1Password, Authy, or any
            RFC 6238 app. The code rotates every 30 seconds.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={startEnroll}
            disabled={isPending}
          >
            Set up authenticator
          </Button>
        </div>
      )}

      {enabled && !setupSecret && (
        <div className="space-y-2">
          <p className="max-w-md text-sm text-muted-foreground">
            Lost your authenticator or switched phones? Reset it to enroll a
            fresh secret — the old one stops working immediately.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={startEnroll}
            disabled={isPending}
          >
            Reset authenticator
          </Button>
        </div>
      )}

      {setupSecret && setupQrUrl && (
        <div className="space-y-3 rounded-md border bg-muted/20 p-4">
          <p className="text-sm">
            Scan the QR code, or paste this secret into your app:
          </p>
          <div className="rounded bg-background px-2 py-1 font-mono text-xs">
            {setupSecret}
          </div>
          {/* Render QR via Google Charts? No — we use a CSP-friendly DataURL
              QR inside the action result. Falling back to plain text + a
              link for now to keep this PR scoped. */}
          <a
            href={setupQrUrl}
            className="text-xs text-muted-foreground underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open otpauth:// link directly
          </a>
          <div className="grid max-w-xs grid-cols-1 gap-2">
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
              size="sm"
              onClick={confirmEnroll}
              disabled={isPending || code.length !== 6}
            >
              {isPending ? "Verifying…" : "Verify & enable"}
            </Button>
          </div>
        </div>
      )}

    </section>
  );
}
