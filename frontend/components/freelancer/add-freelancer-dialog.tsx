"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { useCreateFreelancer } from "@/lib/api/freelancers";
import { requiredPositiveNumber } from "@/lib/zod-helpers";

const schema = z.object({
  name: z.string().min(1, "name is required").max(200),
  daily_cost_eur: requiredPositiveNumber,
  contact_email: z.string().email().optional().or(z.literal("")),
  notes: z.string().optional(),
});
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export function AddFreelancerDialog() {
  const [open, setOpen] = useState(false);
  const create = useCreateFreelancer();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await create.mutateAsync({
        name: values.name,
        daily_cost_eur: values.daily_cost_eur,
        contact_email: values.contact_email || null,
        notes: values.notes || null,
        status: "active",
      });
      toast.success(`Freelancer "${values.name}" added`);
      reset();
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Add Freelancer
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Add freelancer</DialogTitle>
            <DialogDescription>
              External contractor. The daily fee is the cost; we do not apply
              the employer burden factor to freelancers.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" {...register("name")} autoFocus />
              {errors.name && (
                <p className="text-sm text-red-600">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="daily_cost_eur">Daily fee (EUR)</Label>
              <Input
                id="daily_cost_eur"
                type="number"
                step="0.01"
                min="0"
                {...register("daily_cost_eur")}
              />
              {errors.daily_cost_eur && (
                <p className="text-sm text-red-600">
                  {errors.daily_cost_eur.message as string}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="contact_email">Contact email</Label>
              <Input
                id="contact_email"
                type="email"
                {...register("contact_email")}
              />
              {errors.contact_email && (
                <p className="text-sm text-red-600">
                  {errors.contact_email.message}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={3} {...register("notes")} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
