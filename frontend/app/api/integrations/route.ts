import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import type { IntegrationSummary } from "@/lib/api/types";
import { listIntegrations, listRules } from "@/lib/db/queries/integration";
import { getAdapter } from "@/lib/integrations/core/registry";
import { parseRule, type ImportPolicy } from "@/lib/integrations/core/rules";

/** The enabled integrations, with what each provides — what the UI needs
 * to render link cards and import tabs without knowing any provider. */
export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const [rows, rules] = await Promise.all([listIntegrations(), listRules()]);
    const policy = parseRule<ImportPolicy>(
      "projects",
      "import_policy",
      rules.find((r) => r.capability === "projects" && r.key === "import_policy")?.value,
    );
    const integrations: IntegrationSummary[] = rows
      .filter((r) => r.enabled)
      .map((r) => ({
        slug: r.slug,
        display_name: r.display_name,
        provider: r.provider,
        capabilities: [...(getAdapter(r.provider)?.capabilities ?? [])],
      }));
    const importSource = integrations.find((i) => i.slug === policy.integration) ?? null;
    return {
      integrations,
      import_source: importSource
        ? {
            slug: importSource.slug,
            display_name: importSource.display_name,
            customers: policy.customers,
            projects: policy.projects,
          }
        : null,
    };
  });
}
