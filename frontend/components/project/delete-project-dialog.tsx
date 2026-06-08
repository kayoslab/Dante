"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
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
import { useDeleteProject } from "@/lib/api/projects";

type Props = {
  projectId: number;
  customerId: number;
  name: string;
  hasChildren: boolean;
};

export function DeleteProjectDialog({
  projectId,
  customerId,
  name,
  hasChildren,
}: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const del = useDeleteProject(projectId, customerId);

  const onConfirm = async () => {
    try {
      await del.mutateAsync(hasChildren);
      toast.success(`Project "${name}" deleted`);
      setOpen(false);
      router.push(`/customers/${customerId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete project
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete project "{name}"?</DialogTitle>
          <DialogDescription>
            {hasChildren ? (
              <>
                This project has rates and/or assignments. Cascade will remove
                all of them. <strong>This cannot be undone.</strong>
              </>
            ) : (
              <>This action cannot be undone.</>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting…" : hasChildren ? "Cascade delete" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
