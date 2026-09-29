import Link from "next/link";
import { forbidden } from "next/navigation";

import { SyncCard } from "@/components/settings/sync-card";
import { hasRole, requireSession } from "@/lib/auth/session";
import { listIntegrations } from "@/lib/db/queries/integration";

export const metadata = { title: "Run sync — Dante" };

// The Sync UI streams the result of a multi-minute Lambda invoke;
// pre-rendering it would lose the running state across navigations.
export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  const sources = (await listIntegrations())
    .filter((i) => i.enabled)
    .map((i) => ({ slug: i.slug, label: i.display_name }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/settings"
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Run sync
        </h1>
      </div>

      <SyncCard sources={sources} />
    </div>
  );
}
