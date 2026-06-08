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
import { useDeleteCustomer } from "@/lib/api/customers";

type Props = {
  customerId: number;
  name: string;
  hasChildren: boolean;
};

export function DeleteCustomerDialog({ customerId, name, hasChildren }: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const del = useDeleteCustomer();

  const onConfirm = async () => {
    try {
      await del.mutateAsync({ customerId, force: hasChildren });
      toast.success(`Customer "${name}" deleted`);
      setOpen(false);
      router.push("/customers");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete customer "{name}"?</DialogTitle>
          <DialogDescription>
            {hasChildren ? (
              <>
                This customer has framework agreements and/or projects. Deleting
                will cascade and remove every linked framework, project, rate,
                and assignment. <strong>This cannot be undone.</strong>
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
