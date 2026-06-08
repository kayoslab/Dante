import { requireSession } from "@/lib/auth/session";

import { SettingsClient } from "./settings-client";

export const metadata = { title: "Settings — Dante" };

export default async function SettingsPage() {
  await requireSession({ minRole: "admin" });
  return <SettingsClient />;
}
