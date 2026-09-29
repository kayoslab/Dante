"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { updateIntegrationSettingsAction } from "@/lib/actions/integrations";
import type { ConfigField } from "@/lib/integrations/core/config-form";

/** Display name + the provider's non-secret settings, rendered from the
 * adapter's config schema. Values post back as strings and the server
 * coerces + validates against the schema. */
export function IntegrationSettingsForm({
  slug,
  displayName,
  fields,
  config,
}: {
  slug: string;
  displayName: string;
  fields: ConfigField[];
  config: Record<string, unknown>;
}) {
  const router = useRouter();
  const initial: Record<string, string> = {};
  for (const f of fields) {
    const v = config[f.key] ?? f.default;
    initial[f.key] =
      v === undefined || v === null ? "" : f.type === "json" ? JSON.stringify(v) : String(v);
  }
  const [name, setName] = useState(displayName);
  const [values, setValues] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await updateIntegrationSettingsAction(slug, { display_name: name, config: values });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Settings saved");
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  const set = (key: string, v: string) => setValues((s) => ({ ...s, [key]: v }));

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="grid gap-1">
        <Label htmlFor="display-name">Display name</Label>
        <Input id="display-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {fields.length === 0 && (
        <p className="text-xs text-muted-foreground">This provider has no further settings.</p>
      )}
      {fields.map((f) => (
        <div key={f.key} className="grid gap-1">
          <Label htmlFor={`cfg-${f.key}`}>
            {f.label}
            {f.required ? "" : " (optional)"}
          </Label>
          {f.type === "boolean" ? (
            <Switch
              id={`cfg-${f.key}`}
              checked={values[f.key] === "true"}
              onCheckedChange={(c) => set(f.key, c ? "true" : "false")}
            />
          ) : f.type === "enum" ? (
            <select
              id={`cfg-${f.key}`}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
              value={values[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
            >
              {!f.required && <option value="">—</option>}
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : f.type === "json" ? (
            <Textarea
              id={`cfg-${f.key}`}
              className="font-mono"
              value={values[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
            />
          ) : (
            <Input
              id={`cfg-${f.key}`}
              type={f.type === "number" ? "number" : "text"}
              className={f.type === "string" ? "font-mono" : undefined}
              value={values[f.key]}
              onChange={(e) => set(f.key, e.target.value)}
              spellCheck={false}
            />
          )}
          {f.description && <span className="text-xs text-muted-foreground">{f.description}</span>}
        </div>
      ))}
      <Button type="submit" size="sm" disabled={saving || !name.trim()}>
        {saving ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
