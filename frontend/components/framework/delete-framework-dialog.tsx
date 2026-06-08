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
import { useDeleteFramework } from "@/lib/api/frameworks";

type Props = {
  frameworkId: number;
  customerId: number;
  name: string;
  hasChildren: boolean;
};

export function DeleteFrameworkDialog({
  frameworkId,
  customerId,
  name,
  hasChildren,
}: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const del = useDeleteFramework(frameworkId, customerId);

  const onConfirm = async () => {
    try {
      await del.mutateAsync(hasChildren);
      toast.success(`Framework "${name}" deleted`);
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
            Delete framework
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete framework "{name}"?</DialogTitle>
          <DialogDescription>
            {hasChildren ? (
              <>
                This framework has rates and/or linked projects. Cascade will
                remove all rates and unlink projects from the framework.{" "}
                <strong>This cannot be undone.</strong>
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
