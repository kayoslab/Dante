"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { GitMerge } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useCustomer } from "@/lib/api/customers";
import { useMergeProjects } from "@/lib/api/projects";

type Props = {
  targetProjectId: number;
  customerId: number;
  targetName: string;
};

/** Merge another project of the same customer into this one.
 *
 * The "target" is the project currently on screen; the operator picks a
 * "source" that gets folded into it. After the merge the source row is
 * gone and the user lands on the target's detail page (refreshed). */
export function MergeProjectDialog({ targetProjectId, customerId, targetName }: Props) {
  const [open, setOpen] = useState(false);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const router = useRouter();
  const { data: customer } = useCustomer(customerId);
  const merge = useMergeProjects(targetProjectId, customerId);

  // Same-customer candidates only — cross-customer merges are almost
  // always a mistake (different SOWs, different framework, different
  // invoicing entity), so we hide them by default.
  const candidates =
    customer?.projects.filter((p) => p.project_id !== targetProjectId) ?? [];

  const onConfirm = async () => {
    if (sourceId === null) return;
    try {
      const result = await merge.mutateAsync(sourceId);
      toast.success(
        `Merged. Moved ${result.moved_assignments} assignment(s), ${result.moved_rates} rate(s)` +
          (result.dropped_rates > 0
            ? `, dropped ${result.dropped_rates} duplicate rate(s).`
            : "."),
      );
      setOpen(false);
      setSourceId(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <GitMerge className="mr-2 h-4 w-4" />
            Merge into this
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge another project into "{targetName}"</DialogTitle>
          <DialogDescription>
            Pick a project to fold into this one. All of its assignments,
            rates, and Personio/awork links move here. The source project is
            then deleted. Conflicting rate rows (same profile + valid_from)
            are dropped from the source — this project's rates win.{" "}
            <strong>This cannot be undone.</strong>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="merge-source">
            Source project (will be deleted)
          </label>
          <select
            id="merge-source"
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            value={sourceId ?? ""}
            onChange={(e) =>
              setSourceId(e.target.value ? Number(e.target.value) : null)
            }
            disabled={merge.isPending}
          >
            <option value="">— select —</option>
            {candidates.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                #{p.project_id} · {p.name} ({p.status})
              </option>
            ))}
          </select>
          {candidates.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No other projects on this customer.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={merge.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={merge.isPending || sourceId === null}
          >
            {merge.isPending ? "Merging…" : "Merge & delete source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
