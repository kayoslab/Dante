"use client";

import { useState, useTransition } from "react";
import { KeyRound, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changePasswordAction,
  completePasskeyRegistrationAction,
  confirmTotpEnrollmentAction,
  deletePasskeyAction,
  disableTotpAction,
  listPasskeysAction,
  startPasskeyRegistrationAction,
  startTotpEnrollmentAction,
} from "@/lib/actions/profile";

/** Account-security card on the profile page. Three sub-sections:
 *   - password (change-with-current)
 *   - passkeys (list + add + remove; add uses the browser WebAuthn API)
 *   - TOTP (show current state, enroll, disable)
 *
 * Initial passkey list + TOTP status come pre-fetched as props so the
 * card renders with content on first paint. Mutations refresh via the
 * exposed Server Actions and a local `useState` swap. */

export type Passkey = {
  credential_id: string;
  friendly_name: string | null;
  created_at: string | null;
  authenticator_attachment: string | null;
};

export function SecurityCard({
  initialPasskeys,
  initialTotpEnabled,
}: {
  initialPasskeys: Passkey[];
  initialTotpEnabled: boolean;
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
        <PasskeySection initial={initialPasskeys} />
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
// Passkeys
// ---------------------------------------------------------------------------

function PasskeySection({ initial }: { initial: Passkey[] }) {
  const [passkeys, setPasskeys] = useState<Passkey[]>(initial);
  const [isPending, startTransition] = useTransition();

  const refresh = async () => {
    const r = await listPasskeysAction();
    if (r.ok) setPasskeys(r.data);
  };

  const addPasskey = () =>
    startTransition(async () => {
      // 1. Ask Cognito for the WebAuthn challenge.
      const startRes = await startPasskeyRegistrationAction();
      if (!startRes.ok) {
        toast.error(startRes.error.detail);
        return;
      }
      // 2. Run the browser ceremony. The shape returned by Cognito is the
      //    standard PublicKeyCredentialCreationOptions but with bytes
      //    encoded as base64url strings, so we decode them before passing
      //    to `navigator.credentials.create()`.
      try {
        const opts = decodePublicKeyOptions(
          startRes.data.creation_options as Record<string, unknown>,
        );
        const cred = (await navigator.credentials.create({
          publicKey: opts,
        })) as PublicKeyCredential | null;
        if (!cred) {
          toast.error("Passkey creation cancelled.");
          return;
        }
        // 3. Encode the response back to base64url and forward to Cognito.
        const credentialJson = encodeCredentialResponse(cred);
        const finishRes = await completePasskeyRegistrationAction({
          credential: credentialJson,
        });
        if (!finishRes.ok) {
          toast.error(finishRes.error.detail);
          return;
        }
        toast.success("Passkey added.");
        refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toast.error(`Passkey registration failed: ${message}`);
      }
    });

  const removePasskey = (credential_id: string, label: string) =>
    startTransition(async () => {
      if (
        !confirm(
          `Remove ${label}? You won't be able to sign in with it after.`,
        )
      ) {
        return;
      }
      const r = await deletePasskeyAction({ credential_id });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Passkey removed.");
      refresh();
    });

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <KeyIcon />
          <h3 className="text-sm font-semibold">Passkeys</h3>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={addPasskey}
          disabled={isPending}
        >
          Add passkey
        </Button>
      </header>
      {passkeys.length === 0 ? (
        <p className="max-w-md text-sm text-muted-foreground">
          No passkeys registered. Add one to sign in without a password —
          your device unlocks with Touch ID, Face ID, Windows Hello, or a
          security key, and Cognito accepts that as a strong MFA factor.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {passkeys.map((p) => {
            const label = p.friendly_name ?? "Passkey";
            return (
              <li
                key={p.credential_id}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="font-medium">{label}</div>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    {p.authenticator_attachment && (
                      <Badge variant="outline" className="text-[10px]">
                        {p.authenticator_attachment}
                      </Badge>
                    )}
                    {p.created_at && (
                      <span>
                        added {new Date(p.created_at).toLocaleDateString("de-DE")}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => removePasskey(p.credential_id, label)}
                  disabled={isPending}
                  aria-label={`Remove ${label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            );
          })}
        </ul>
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

  const disable = () =>
    startTransition(async () => {
      if (
        !confirm(
          "Disable the authenticator app? Cognito will reject this unless you have a passkey registered.",
        )
      ) {
        return;
      }
      const r = await disableTotpAction();
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Authenticator disabled.");
      setEnabled(false);
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

      {!enabled && setupSecret && setupQrUrl && (
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

      {enabled && (
        <Button
          size="sm"
          variant="ghost"
          onClick={disable}
          disabled={isPending}
        >
          Disable authenticator
        </Button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// WebAuthn encoding helpers
// ---------------------------------------------------------------------------

function base64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (norm.length % 4)) % 4;
  const padded = norm + "=".repeat(pad);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64url(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode Cognito's WebAuthn options so `navigator.credentials.create()`
 * gets `BufferSource` for the byte fields. The wire format encodes them
 * as base64url strings, which the WebAuthn API does NOT accept directly. */
function decodePublicKeyOptions(
  raw: Record<string, unknown>,
): PublicKeyCredentialCreationOptions {
  const pubKey = raw.publicKey ?? raw;
  const o = pubKey as Record<string, unknown>;
  return {
    ...(o as object),
    challenge: base64urlToBytes(o.challenge as string),
    user: {
      ...(o.user as object),
      id: base64urlToBytes((o.user as { id: string }).id),
    },
    excludeCredentials: (
      (o.excludeCredentials as Array<{ id: string }> | undefined) ?? []
    ).map((c) => ({ ...c, id: base64urlToBytes(c.id) })),
  } as unknown as PublicKeyCredentialCreationOptions;
}

/** Re-encode the browser's `PublicKeyCredential` to base64url JSON for
 * the round-trip back to Cognito. */
function encodeCredentialResponse(cred: PublicKeyCredential): Record<string, unknown> {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bytesToBase64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: cred.authenticatorAttachment,
    response: {
      clientDataJSON: bytesToBase64url(r.clientDataJSON),
      attestationObject: bytesToBase64url(r.attestationObject),
    },
    clientExtensionResults: cred.getClientExtensionResults(),
  };
}

function KeyIcon() {
  return <KeyRound className="h-4 w-4 text-muted-foreground" />;
}
