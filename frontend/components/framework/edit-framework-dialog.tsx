"use client";

import { Pencil } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FormDialog, FormField } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateFramework } from "@/lib/api/frameworks";

const schema = z
  .object({
    name: z.string().min(1, "name is required").max(200),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine(
    (v) =>
      !v.start_date ||
      !v.end_date ||
      new Date(v.start_date) <= new Date(v.end_date),
    { path: ["end_date"], message: "end date must be on or after start date" },
  );

type Props = {
  frameworkId: number;
  customerId: number;
  initial: {
    name: string;
    start_date: string | null | undefined;
    end_date: string | null | undefined;
    notes: string | null | undefined;
  };
};

export function EditFrameworkDialog({
  frameworkId,
  customerId,
  initial,
}: Props) {
  const update = useUpdateFramework(frameworkId, customerId);
  const defaults = {
    name: initial.name,
    start_date: initial.start_date ?? "",
    end_date: initial.end_date ?? "",
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
      title="Edit framework"
      description="Renaming is allowed; the name must stay unique within the customer."
      schema={schema}
      defaultValues={defaults}
      mutation={update}
      buildPayload={(v) => ({
        name: v.name,
        start_date: v.start_date || null,
        end_date: v.end_date || null,
        notes: v.notes ?? null,
      })}
      successMessage="Framework updated"
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
            <FormField label="Start date" htmlFor="start_date">
              <Input
                id="start_date"
                type="date"
                {...form.register("start_date")}
              />
            </FormField>
            <FormField
              label="End date"
              htmlFor="end_date"
              error={form.formState.errors.end_date}
            >
              <Input id="end_date" type="date" {...form.register("end_date")} />
            </FormField>
          </div>
          <FormField label="Notes" htmlFor="notes">
            <Textarea id="notes" rows={3} {...form.register("notes")} />
          </FormField>
        </>
      )}
    </FormDialog>
  );
}
