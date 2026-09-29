"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { setIntegrationEnabledAction } from "@/lib/actions/integrations";

/** Enabled / disabled toggle for one integration. Disabled integrations
 * keep their credentials and bindings but the runner skips them. */
export function EnableSwitch({
  slug,
  enabled,
  label = true,
}: {
  slug: string;
  enabled: boolean;
  label?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(enabled);
  const [pending, setPending] = useState(false);

  async function toggle(next: boolean) {
    setPending(true);
    setValue(next);
    try {
      const r = await setIntegrationEnabledAction(slug, next);
      if (!r.ok) {
        setValue(!next);
        toast.error(r.error.detail);
        return;
      }
      toast.success(next ? "Integration enabled" : "Integration disabled");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Switch
        id={`enabled-${slug}`}
        checked={value}
        disabled={pending}
        onCheckedChange={(checked) => void toggle(checked)}
        aria-label={`${slug} enabled`}
      />
      {label && (
        <Label htmlFor={`enabled-${slug}`} className="text-xs text-muted-foreground">
          {value ? "Enabled" : "Disabled"}
        </Label>
      )}
    </div>
  );
}
