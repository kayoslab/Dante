"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button, type buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import type { VariantProps } from "class-variance-authority";

type Props = {
  /** Title shown in the dialog header. */
  title: string;
  /** Body explaining consequences. */
  description: ReactNode;
  /** Called when the user confirms. Should throw on error to surface via toast. */
  onConfirm: () => Promise<void>;
  /** Optional trigger override; default is a small outline Trash2 button. */
  trigger?: ReactElement;
  /** Final button label when not cascading. */
  confirmLabel?: string;
  /** Toast success message when onConfirm resolves. */
  successMessage?: string;
  /** Cosmetic icon-only button by default; pass false for a normal-sized button. */
  iconOnly?: boolean;
  /** Pass a variant if not using `trigger`. */
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
};

export function ConfirmDeleteButton({
  title,
  description,
  onConfirm,
  trigger,
  confirmLabel = "Delete",
  successMessage,
  iconOnly = true,
  triggerVariant = "ghost",
}: Props) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const run = async () => {
    setPending(true);
    try {
      await onConfirm();
      if (successMessage) toast.success(successMessage);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setPending(false);
    }
  };

  const defaultTrigger = iconOnly ? (
    <Button variant={triggerVariant} size="sm">
      <Trash2 className="h-4 w-4" />
    </Button>
  ) : (
    <Button variant={triggerVariant} size="sm">
      <Trash2 className="mr-2 h-4 w-4" />
      Delete
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger ?? defaultTrigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button variant="destructive" onClick={run} disabled={pending}>
            {pending ? "Deleting…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
