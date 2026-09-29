"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setRuleAction } from "@/lib/actions/integrations";
import type { RuleKind } from "@/lib/integrations/core/rules";

import type { IntegrationOption } from "./bindings-editor";

export type RuleItem = {
  capability: string;
  key: string;
  kind: RuleKind;
  label: string;
  description: string;
  value: Record<string, unknown>;
  /** Integrations that make sense as a reference for this rule (bound to
   *  the capability, or providing it). */
  candidates: string[];
};

export function RulesEditor({
  rules,
  integrations,
}: {
  rules: RuleItem[];
  integrations: IntegrationOption[];
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rules.map((r) => (
        <RuleCard key={`${r.capability}.${r.key}`} rule={r} integrations={integrations} />
      ))}
    </div>
  );
}

function RuleCard({ rule, integrations }: { rule: RuleItem; integrations: IntegrationOption[] }) {
  const router = useRouter();
  const [value, setValue] = useState<Record<string, unknown>>(rule.value);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(value) !== JSON.stringify(rule.value);
  const nameOf = (slug: string) => integrations.find((i) => i.slug === slug)?.display_name ?? slug;
  const candidates = integrations.filter((i) => rule.candidates.includes(i.slug));

  async function save() {
    setSaving(true);
    try {
      const r = await setRuleAction(rule.capability, rule.key, value);
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success(`${rule.label}: saved`);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const selectClass = "h-8 rounded-lg border border-input bg-transparent px-2 text-sm";

  let body: React.ReactNode;
  if (rule.kind === "overlap_policy") {
    const kind = value.kind === "day_wins" ? "day_wins" : "merge";
    body = (
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          className={selectClass}
          value={kind}
          onChange={(e) =>
            setValue(
              e.target.value === "merge"
                ? { kind: "merge" }
                : { kind: "day_wins", integration: (value.integration as string) ?? candidates[0]?.slug ?? "" },
            )
          }
          aria-label="overlap policy"
        >
          <option value="day_wins">One source wins the day</option>
          <option value="merge">Keep both</option>
        </select>
        {kind === "day_wins" && (
          <>
            <span className="text-muted-foreground">winner:</span>
            <select
              className={selectClass}
              value={(value.integration as string) ?? ""}
              onChange={(e) => setValue({ kind: "day_wins", integration: e.target.value })}
              aria-label="winning integration"
            >
              {candidates.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
    );
  } else if (rule.kind === "auto_link") {
    const list = Array.isArray(value.integrations) ? (value.integrations as string[]) : [];
    body = (
      <div className="space-y-2 text-sm">
        {candidates.length === 0 && (
          <p className="text-muted-foreground">No integration provides this capability.</p>
        )}
        {candidates.map((c) => (
          <div key={c.slug} className="flex items-center gap-2">
            <Switch
              id={`${rule.capability}-${rule.key}-${c.slug}`}
              size="sm"
              checked={list.includes(c.slug)}
              onCheckedChange={(on) =>
                setValue({
                  integrations: on ? [...list, c.slug] : list.filter((s) => s !== c.slug),
                })
              }
            />
            <Label htmlFor={`${rule.capability}-${rule.key}-${c.slug}`}>{c.display_name}</Label>
          </div>
        ))}
      </div>
    );
  } else {
    const flags = ["customers", "projects", "refresh_dates", "apply_money"] as const;
    const flagLabel: Record<(typeof flags)[number], string> = {
      customers: "Create customers from unlinked companies",
      projects: "Create projects from unlinked projects (linked company required)",
      refresh_dates: "Planned dates / budget / notes / status follow the source",
      apply_money: "Apply provider money fields (rates, fixed price) to imported projects",
    };
    body = (
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Import from:</span>
          <select
            className={selectClass}
            value={(value.integration as string | null) ?? ""}
            onChange={(e) => setValue({ ...value, integration: e.target.value || null })}
            aria-label="import source"
          >
            <option value="">— none —</option>
            {candidates.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
        {flags.map((f) => (
          <div key={f} className="flex items-center gap-2">
            <Switch
              id={`import-${f}`}
              size="sm"
              checked={Boolean(value[f])}
              onCheckedChange={(on) => setValue({ ...value, [f]: on })}
            />
            <Label htmlFor={`import-${f}`}>{flagLabel[f]}</Label>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{rule.label}</CardTitle>
        <p className="text-xs text-muted-foreground">{rule.description}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {body}
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {dirty && (
            <Button size="sm" variant="ghost" onClick={() => setValue(rule.value)} disabled={saving}>
              Reset
            </Button>
          )}
          {rule.kind === "overlap_policy" && value.kind === "day_wins" && (
            <span className="text-xs text-muted-foreground">
              {nameOf(String(value.integration))} wins any day it has time on.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
