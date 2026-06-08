import { redirect } from "next/navigation";

import { requireSession } from "@/lib/auth/session";

import { MfaVerifyClient } from "./verify-client";

export const metadata = { title: "Verify MFA — Dante" };

export const dynamic = "force-dynamic";

export default async function MfaVerifyPage() {
  const ctx = await requireSession({ allowMfaPending: true });
  if (!ctx.mfa_enrolled) redirect("/auth/mfa/setup");
  if (ctx.mfa_verified) redirect("/");

  return (
    <div className="mx-auto max-w-md">
      <MfaVerifyClient />
    </div>
  );
}
