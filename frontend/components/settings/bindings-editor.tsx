"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setBindingsAction } from "@/lib/actions/integrations";

export type IntegrationOption = {
  slug: string;
  display_name: string;
  enabled: boolean;
  capabilities: string[];
};

export type CapabilityBinding = {
  capability: string;
  label: string;
  description: string;
  /** Bound integration slugs in priority order (index 0 = primary). */
  slugs: string[];
};

/** One card per capability: the ordered sources, reorder / remove, and an
 * "add" picker limited to integrations whose adapter provides the
 * capability. Each card saves on its own. */
export function BindingsEditor({
  capabilities,
  integrations,
}: {
  capabilities: CapabilityBinding[];
  integrations: IntegrationOption[];
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {capabilities.map((c) => (
        <CapabilityCard key={c.capability} binding={c} integrations={integrations} />
      ))}
    </div>
  );
}

function CapabilityCard({
  binding,
  integrations,
}: {
  binding: CapabilityBinding;
  integrations: IntegrationOption[];
}) {
  const router = useRouter();
  const [slugs, setSlugs] = useState(binding.slugs);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(slugs) !== JSON.stringify(binding.slugs);

  const eligible = integrations.filter(
    (i) => i.capabilities.includes(binding.capability) && !slugs.includes(i.slug),
  );
  const nameOf = (slug: string) => integrations.find((i) => i.slug === slug)?.display_name ?? slug;
  const isEnabled = (slug: string) => integrations.find((i) => i.slug === slug)?.enabled ?? false;

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= slugs.length) return;
    const next = [...slugs];
    [next[i], next[j]] = [next[j], next[i]];
    setSlugs(next);
  }

  async function save() {
    setSaving(true);
    try {
      const r = await setBindingsAction(binding.capability, slugs);
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success(`${binding.label}: sources saved`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{binding.label}</CardTitle>
        <p className="text-xs text-muted-foreground">{binding.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {slugs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No source — this capability is not synced.</p>
        ) : (
          <ol className="space-y-1">
            {slugs.map((slug, i) => (
              <li key={slug} className="flex items-center gap-2 rounded border px-2 py-1 text-sm">
                <span className="w-6 text-xs tabular-nums text-muted-foreground">{i + 1}.</span>
                <span className="flex-1">
                  {nameOf(slug)}
                  {!isEnabled(slug) && (
                    <Badge variant="outline" className="ml-2">
                      disabled
                    </Badge>
                  )}
                  {i === 0 && (
                    <Badge variant="secondary" className="ml-2">
                      primary
                    </Badge>
                  )}
                </span>
                <Button variant="ghost" size="icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="move up">
                  <ArrowUp className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(i, 1)}
                  disabled={i === slugs.length - 1}
                  aria-label="move down"
                >
                  <ArrowDown className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setSlugs(slugs.filter((s) => s !== slug))}
                  aria-label="remove"
                >
                  <X className="size-4" />
                </Button>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {eligible.length > 0 && (
            <select
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              value=""
              onChange={(e) => {
                if (e.target.value) setSlugs([...slugs, e.target.value]);
              }}
              aria-label={`add source for ${binding.label}`}
            >
              <option value="">Add source…</option>
              {eligible.map((i) => (
                <option key={i.slug} value={i.slug}>
                  {i.display_name}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save order"}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setSlugs(binding.slugs)} disabled={saving}>
              Reset
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
