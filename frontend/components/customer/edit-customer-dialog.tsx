"use client";

import { Pencil } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FormDialog, FormField } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateCustomer } from "@/lib/api/customers";

const schema = z.object({
  name: z.string().min(1, "name is required").max(200),
  notes: z.string().optional(),
});

type Props = {
  customerId: number;
  initial: { name: string; notes: string | null | undefined };
};

export function EditCustomerDialog({ customerId, initial }: Props) {
  const update = useUpdateCustomer(customerId);
  const defaults = { name: initial.name, notes: initial.notes ?? "" };

  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm">
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </Button>
      }
      title="Edit customer"
      description="Customer names must remain unique."
      schema={schema}
      defaultValues={defaults}
      mutation={update}
      buildPayload={(v) => ({ name: v.name, notes: v.notes ?? null })}
      successMessage="Customer updated"
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
          <FormField
            label="Notes"
            htmlFor="notes"
          >
            <Textarea id="notes" rows={3} {...form.register("notes")} />
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
