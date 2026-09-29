"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addIntegrationAction } from "@/lib/actions/integrations";

export type ProviderOption = { slug: string; displayName: string; capabilities: string[] };

/** Create an integration row from a registered provider. The row starts
 * disabled with no credentials; the detail page takes it from there. */
export function AddIntegrationDialog({ providers }: { providers: ProviderOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState(providers[0]?.slug ?? "");
  const [slug, setSlug] = useState(providers[0]?.slug ?? "");
  const [displayName, setDisplayName] = useState(providers[0]?.displayName ?? "");
  const [pending, setPending] = useState(false);

  function pick(p: string) {
    setProvider(p);
    const opt = providers.find((x) => x.slug === p);
    if (opt) {
      setSlug(opt.slug);
      setDisplayName(opt.displayName);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    try {
      const r = await addIntegrationAction({ provider, slug, display_name: displayName });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success(`${displayName} added`);
      setOpen(false);
      router.push(`/settings/integrations/${r.data.slug}`);
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" disabled={providers.length === 0}>
            <Plus className="mr-1.5 size-4" />
            Add integration
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add integration</DialogTitle>
            <DialogDescription>
              Pick a provider from the registry. The integration starts disabled; enter its
              credentials and bind capabilities afterwards.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <div className="grid gap-1">
              <Label htmlFor="add-provider">Provider</Label>
              <select
                id="add-provider"
                className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm"
                value={provider}
                onChange={(e) => pick(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.displayName} — {p.capabilities.join(", ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="add-slug">Slug</Label>
              <Input
                id="add-slug"
                className="font-mono"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                pattern="[a-z][a-z0-9_-]*"
                spellCheck={false}
              />
              <span className="text-xs text-muted-foreground">
                Lower-case identifier; appears in URLs and secret names. Cannot be changed later.
              </span>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="add-name">Display name</Label>
              <Input id="add-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !slug || !displayName}>
              {pending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
