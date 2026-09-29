"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveIntegrationCredentialsAction } from "@/lib/actions/integrations";
import type { CredentialField } from "@/lib/integrations/core/types";

/** Write-only credential entry. Secret fields render as password inputs
 * and the form never receives current values — it starts empty every
 * time and the server replaces the stored document on save. */
export function CredentialForm({
  slug,
  fields,
  writable,
  storeHint,
}: {
  slug: string;
  fields: CredentialField[];
  writable: boolean;
  storeHint: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const missingRequired = fields.some((f) => f.required && !values[f.key]?.trim());

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const r = await saveIntegrationCredentialsAction(slug, values);
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success("Credentials stored");
      setValues({});
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  if (!writable) {
    return (
      <div className="rounded border bg-muted/30 p-3 text-sm text-muted-foreground">
        This deployment&rsquo;s secret store is read-only from the UI. {storeHint}
      </div>
    );
  }

  return (
    <form onSubmit={save} className="space-y-3" autoComplete="off">
      {fields.map((f) => (
        <div key={f.key} className="grid gap-1">
          <Label htmlFor={`cred-${f.key}`}>
            {f.label}
            {f.required ? "" : " (optional)"}
          </Label>
          <Input
            id={`cred-${f.key}`}
            name={f.key}
            type={f.secret ? "password" : "text"}
            autoComplete={f.secret ? "new-password" : "off"}
            spellCheck={false}
            className="font-mono"
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </div>
      ))}
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={saving || missingRequired}>
          {saving ? "Storing…" : "Store credentials"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Never shown again after saving.
        </span>
      </div>
    </form>
  );
}
