import { redirect } from "next/navigation";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { startMfaEnrollmentAction } from "@/lib/actions/mfa";
import { requireSession } from "@/lib/auth/session";

import { MfaSetupClient } from "./setup-client";

export const metadata = { title: "Set up MFA — Dante" };

// Always fresh — the QR encodes a one-time secret that we don't want
// cached across loads.
export const dynamic = "force-dynamic";

export default async function MfaSetupPage() {
  const ctx = await requireSession({ allowMfaPending: true });

  // Already enrolled? Verify is the right next step.
  if (ctx.mfa_enrolled && !ctx.mfa_verified) redirect("/auth/mfa/verify");
  // Already verified, MFA not required → no reason to be here.
  if (!ctx.mfa_required && !ctx.mfa_enrolled) redirect("/");
  // Already enrolled + verified → done.
  if (ctx.mfa_enrolled && ctx.mfa_verified) redirect("/");

  const result = await startMfaEnrollmentAction();
  if (!result.ok) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MFA setup unavailable</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-red-700">
          {result.error.detail}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <MfaSetupClient
        secret={result.data.secret}
        qr_data_url={result.data.qr_data_url}
        email={ctx.email}
      />
    </div>
  );
}
