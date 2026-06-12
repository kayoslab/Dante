import { forbidden } from "next/navigation";

import { hasRole, requireSession } from "@/lib/auth/session";

import { SettingsClient } from "./settings-client";

export const metadata = { title: "Settings — Dante" };

export default async function SettingsPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  return <SettingsClient />;
}
