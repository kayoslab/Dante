import Link from "next/link";
import { forbidden } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AddIntegrationDialog } from "@/components/settings/add-integration-dialog";
import { EnableSwitch } from "@/components/settings/integration-controls";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { listIntegrations } from "@/lib/db/queries/integration";
import { getAdapter, PROVIDERS } from "@/lib/integrations/core/registry";
import { getSecretStore } from "@/lib/integrations/core/secret-store";

import { CredentialStateBadge, formatWhen } from "./_status";

export const metadata = { title: "Integrations — Dante" };

export default async function IntegrationsPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  await audit(ctx, { action: "view_integrations", target_type: "integration" });

  const rows = await listIntegrations();
  const store = getSecretStore();
  const providers = PROVIDERS.map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    capabilities: [...p.capabilities],
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/settings" className="text-sm text-muted-foreground hover:underline">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          The external tools Dante pulls from. Credentials are stored write-only in the{" "}
          <span className="font-medium">{store.kind}</span> secret store — {store.describe()}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href="/settings/integrations/bindings"
          className={buttonVariants({ size: "sm", variant: "outline" })}
        >
          Sources &amp; rules
        </Link>
        <Link href="/settings/sync" className={buttonVariants({ size: "sm", variant: "outline" })}>
          Run sync
        </Link>
        <AddIntegrationDialog providers={providers} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map((row) => {
          const adapter = getAdapter(row.provider);
          return (
            <Card key={row.slug}>
              <CardContent className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-medium">{row.display_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {adapter ? adapter.displayName : `unknown provider "${row.provider}"`} ·{" "}
                      {adapter?.capabilities.join(", ")}
                    </div>
                  </div>
                  <EnableSwitch slug={row.slug} enabled={row.enabled} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <CredentialStateBadge state={row.credential_state} />
                  <span>
                    Last sync:{" "}
                    {row.last_sync_at ? (
                      <>
                        {formatWhen(row.last_sync_at)}
                        {row.last_sync_status === "error" ? " (errors)" : ""}
                      </>
                    ) : (
                      "never"
                    )}
                  </span>
                </div>
                <div className="flex justify-end">
                  <Link
                    href={`/settings/integrations/${row.slug}`}
                    className={buttonVariants({ size: "sm", variant: "outline" })}
                  >
                    Configure
                  </Link>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
