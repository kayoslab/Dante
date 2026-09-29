import Link from "next/link";
import { forbidden } from "next/navigation";

import { BindingsEditor, type IntegrationOption } from "@/components/settings/bindings-editor";
import { RulesEditor, type RuleItem } from "@/components/settings/rules-editor";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";
import { listBindings, listIntegrations, listRules } from "@/lib/db/queries/integration";
import { CAPABILITY_LABELS, CAPABILITY_ORDER } from "@/lib/integrations/core/capabilities";
import { getAdapter } from "@/lib/integrations/core/registry";
import { parseRule, RULE_CATALOG } from "@/lib/integrations/core/rules";

export const metadata = { title: "Sources & rules — Dante" };

export const dynamic = "force-dynamic";

/** The logical connection between integrations and Dante: which source
 * feeds each capability (in priority order) and the per-capability rules
 * the sync applies around them. */
export default async function BindingsPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();
  await audit(ctx, { action: "view_bindings", target_type: "capability" });

  const [rows, bindings, rules] = await Promise.all([listIntegrations(), listBindings(), listRules()]);

  const integrations: IntegrationOption[] = rows.map((r) => ({
    slug: r.slug,
    display_name: r.display_name,
    enabled: r.enabled,
    capabilities: [...(getAdapter(r.provider)?.capabilities ?? [])],
  }));

  const capabilities = CAPABILITY_ORDER.map((capability) => ({
    capability,
    label: CAPABILITY_LABELS[capability].label,
    description: CAPABILITY_LABELS[capability].description,
    slugs: bindings
      .filter((b) => b.capability === capability)
      .sort((a, b) => a.priority - b.priority)
      .map((b) => b.integration_slug),
  }));

  const ruleItems: RuleItem[] = RULE_CATALOG.map((def) => {
    const stored = rules.find((r) => r.capability === def.capability && r.key === def.key)?.value;
    const bound = capabilities.find((c) => c.capability === def.capability)?.slugs ?? [];
    const providing = integrations.filter((i) => i.capabilities.includes(def.capability)).map((i) => i.slug);
    return {
      capability: def.capability,
      key: def.key,
      kind: def.kind,
      label: def.label,
      description: def.description,
      value: parseRule<Record<string, unknown>>(def.capability, def.key, stored),
      candidates: [...new Set([...bound, ...providing])],
    };
  });

  return (
    <div className="space-y-8">
      <div>
        <Link href="/settings/integrations" className="text-sm text-muted-foreground hover:underline">
          ← Integrations
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Sources &amp; rules</h1>
        <p className="text-sm text-muted-foreground">
          For each kind of data, which integration provides it and in what order. The first source
          is primary; disabled integrations stay bound but are skipped by the sync.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Sources per capability</h2>
        <BindingsEditor capabilities={capabilities} integrations={integrations} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Rules</h2>
        <p className="text-sm text-muted-foreground">
          What the sync does around the sources: reconciliation between overlapping data, automatic
          linking, and what gets imported into Dante.
        </p>
        <RulesEditor rules={ruleItems} integrations={integrations} />
      </section>
    </div>
  );
}
