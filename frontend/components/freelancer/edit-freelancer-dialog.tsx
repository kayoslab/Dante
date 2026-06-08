"use client";

import { Pencil } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FormDialog, FormField } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateFreelancer } from "@/lib/api/freelancers";
import { requiredPositiveNumber } from "@/lib/zod-helpers";

const schema = z.object({
  name: z.string().min(1, "name is required").max(200),
  daily_cost_eur: requiredPositiveNumber,
  contact_email: z.string().email().optional().or(z.literal("")),
  status: z.string().min(1),
  notes: z.string().optional(),
});
type FormInput = z.input<typeof schema>;

type Props = {
  freelancerId: number;
  initial: {
    name: string;
    daily_cost_eur: string;
    contact_email: string | null | undefined;
    status: string;
    notes: string | null | undefined;
  };
};

export function EditFreelancerDialog({ freelancerId, initial }: Props) {
  const update = useUpdateFreelancer(freelancerId);

  const defaults: FormInput = {
    name: initial.name,
    daily_cost_eur: initial.daily_cost_eur,
    contact_email: initial.contact_email ?? "",
    status: initial.status,
    notes: initial.notes ?? "",
  };

  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm">
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </Button>
      }
      title="Edit freelancer"
      description="Changing the daily fee affects margin calculations for any open assignments at the next view refresh."
      schema={schema}
      defaultValues={defaults}
      mutation={update}
      buildPayload={(v) => ({
        name: v.name,
        daily_cost_eur: v.daily_cost_eur,
        contact_email: v.contact_email || null,
        status: v.status,
        notes: v.notes ?? null,
      })}
      successMessage="Freelancer updated"
      disableSubmitWhilePristine
      resetOnOpen
    >
      {(form) => (
        <>
          <FormField
            label="Name"
            htmlFor="name"
            error={form.formState.errors.name}
          >
            <Input id="name" {...form.register("name")} autoFocus />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField
              label="Daily fee (EUR)"
              htmlFor="daily_cost_eur"
              error={form.formState.errors.daily_cost_eur}
            >
              <Input
                id="daily_cost_eur"
                type="number"
                step="0.01"
                min="0"
                {...form.register("daily_cost_eur")}
              />
            </FormField>
            <div className="space-y-1.5">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                {...form.register("status")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="active">active</option>
                <option value="inactive">inactive</option>
              </select>
            </div>
          </div>
          <FormField label="Contact email" htmlFor="contact_email">
            <Input
              id="contact_email"
              type="email"
              {...form.register("contact_email")}
            />
          </FormField>
          <FormField label="Notes" htmlFor="notes">
            <Textarea id="notes" rows={3} {...form.register("notes")} />
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
