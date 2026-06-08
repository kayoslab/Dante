"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { completeMfaEnrollmentAction } from "@/lib/actions/mfa";

export function MfaSetupClient({
  secret,
  qr_data_url,
  email,
}: {
  secret: string;
  qr_data_url: string;
  email: string;
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await completeMfaEnrollmentAction({ secret, code });
      if (!res.ok) {
        toast.error(res.error.detail);
        return;
      }
      toast.success("MFA enrolled");
      router.replace("/");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Set up two-factor authentication</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
          <li>
            Open your authenticator app (1Password, Authy, Google
            Authenticator, etc.).
          </li>
          <li>Scan the QR code below — or paste the secret manually.</li>
          <li>Enter the 6-digit code the app shows to confirm.</li>
        </ol>

        <div className="flex flex-col items-center gap-3 rounded border bg-muted/30 p-4">
          <Image
            src={qr_data_url}
            width={220}
            height={220}
            alt="MFA enrollment QR code"
            // The QR is a data: URL — turning off Next.js optimization is
            // both correct and required (the optimizer doesn't proxy
            // data URLs).
            unoptimized
          />
          <div className="text-center text-xs text-muted-foreground">
            Account: <code className="font-mono">{email}</code>
          </div>
          <details className="w-full text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Or enter the secret manually
            </summary>
            <pre className="mt-2 break-all rounded bg-background p-2 font-mono">
              {secret}
            </pre>
          </details>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="code">6-digit code</Label>
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              className="font-mono tracking-widest"
            />
          </div>
          <Button type="submit" disabled={submitting || code.length < 6}>
            {submitting ? "Verifying…" : "Confirm & finish"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
