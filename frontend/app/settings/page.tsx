import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { forbidden } from "next/navigation";

import { hasRole, requireSession } from "@/lib/auth/session";
import { listTeams } from "@/lib/db/queries/team";
import { getQueryClient } from "@/lib/query/server";
import { buildSettingsList } from "@/lib/reports/settings";

import { SettingsClient } from "./settings-client";

export const metadata = { title: "Settings — Dante" };

export default async function SettingsPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();

  // Prefetch what `SettingsClient` asks for on its first render so the
  // first paint ships the settings table + teams card populated:
  //  - `useSettings()` → settingKeys.all  = ["settings"]
  //  - `useTeams()`    → teamKeys.list()  = ["teams", "list"]
  // lib/api/settings.ts and lib/api/teams.ts are "use client" modules, so
  // their key objects aren't importable here — the literals below must
  // stay in sync with those hooks.
  const qc = getQueryClient();
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ["settings"],
      queryFn: () => buildSettingsList(),
    }),
    qc.prefetchQuery({
      queryKey: ["teams", "list"],
      queryFn: () => listTeams(),
    }),
  ]);

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <SettingsClient />
    </HydrationBoundary>
  );
}
