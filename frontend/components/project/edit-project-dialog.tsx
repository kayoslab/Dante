"use client";

import { Pencil } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FormDialog, FormField } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateProject } from "@/lib/api/projects";
import { optionalInt, optionalPositiveNumber } from "@/lib/zod-helpers";

const schema = z
  .object({
    name: z.string().min(1, "name is required").max(200),
    framework_id: optionalInt,
    clear_framework: z.boolean().default(false),
    agreed_amount_eur: optionalPositiveNumber,
    planned_start_date: z.string().optional(),
    planned_end_date: z.string().optional(),
    status: z.string().min(1),
    notes: z.string().optional(),
    billable: z.boolean().default(true),
  })
  .refine(
    (v) =>
      !v.planned_start_date ||
      !v.planned_end_date ||
      new Date(v.planned_start_date) <= new Date(v.planned_end_date),
    {
      path: ["planned_end_date"],
      message: "end date must be on or after start date",
    },
  );
type FormInput = z.input<typeof schema>;

type Props = {
  projectId: number;
  customerId: number;
  initial: {
    name: string;
    framework_id: number | null | undefined;
    agreed_amount_eur: string | null | undefined;
    planned_start_date: string | null | undefined;
    planned_end_date: string | null | undefined;
    status: string;
    notes: string | null | undefined;
    billable: boolean;
  };
  frameworks: { framework_id: number; name: string }[];
};

export function EditProjectDialog({
  projectId,
  customerId,
  initial,
  frameworks,
}: Props) {
  const update = useUpdateProject(projectId, customerId);

  const defaults: FormInput = {
    name: initial.name,
    framework_id: initial.framework_id ?? undefined,
    clear_framework: false,
    agreed_amount_eur: initial.agreed_amount_eur ?? undefined,
    planned_start_date: initial.planned_start_date ?? "",
    planned_end_date: initial.planned_end_date ?? "",
    status: initial.status,
    notes: initial.notes ?? "",
    billable: initial.billable,
  };

  return (
    <FormDialog
      trigger={
        <Button variant="outline" size="sm">
          <Pencil className="mr-2 h-4 w-4" />
          Edit
        </Button>
      }
      title="Edit project"
      description="Billing model is fixed at creation time. To switch model, delete and recreate."
      schema={schema}
      defaultValues={defaults}
      mutation={update}
      buildPayload={(v) => ({
        name: v.name,
        framework_id: v.framework_id ?? null,
        clear_framework: !v.framework_id && !!initial.framework_id,
        agreed_amount_eur: v.agreed_amount_eur ?? null,
        planned_start_date: v.planned_start_date || null,
        planned_end_date: v.planned_end_date || null,
        status: v.status,
        notes: v.notes ?? null,
        billable: v.billable,
      })}
      successMessage="Project updated"
      disableSubmitWhilePristine
      resetOnOpen
      dialogContentClassName="sm:max-w-lg"
    >
      {(form) => {
        const fwField = form.watch("framework_id");
        return (
          <>
            <FormField
              label="Name"
              htmlFor="name"
              error={form.formState.errors.name}
            >
              <Input id="name" {...form.register("name")} autoFocus />
            </FormField>
            <div className="space-y-1.5">
              <Label htmlFor="framework_id">Framework agreement</Label>
              <select
                id="framework_id"
                {...form.register("framework_id")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="">— none —</option>
                {frameworks.map((f) => (
                  <option key={f.framework_id} value={f.framework_id}>
                    {f.name}
                  </option>
                ))}
              </select>
              {!fwField && initial.framework_id && (
                <p className="text-xs text-amber-700">
                  Saving will unlink the current framework.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Agreed amount (EUR)" htmlFor="agreed_amount_eur">
                <Input
                  id="agreed_amount_eur"
                  type="number"
                  step="0.01"
                  min="0"
                  {...form.register("agreed_amount_eur")}
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
                  <option value="paused">paused</option>
                  <option value="completed">completed</option>
                  <option value="cancelled">cancelled</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Planned start" htmlFor="planned_start_date">
                <Input
                  id="planned_start_date"
                  type="date"
                  {...form.register("planned_start_date")}
                />
              </FormField>
              <FormField
                label="Planned end"
                htmlFor="planned_end_date"
                error={form.formState.errors.planned_end_date}
              >
                <Input
                  id="planned_end_date"
                  type="date"
                  {...form.register("planned_end_date")}
                />
              </FormField>
            </div>
            <FormField label="Notes" htmlFor="notes">
              <Textarea id="notes" rows={3} {...form.register("notes")} />
            </FormField>
            <label className="flex items-start gap-2 text-sm">
              <input
                id="billable"
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                {...form.register("billable")}
              />
              <span>
                <span className="font-medium">Billable</span>
                <span className="block text-xs text-muted-foreground">
                  Tracked time on this project counts as billable. Uncheck for
                  internal / non-billable work (counts as bench). Seeded from
                  Personio/awork; override here.
                </span>
              </span>
            </label>
          </>
        );
      }}
    </FormDialog>
  );
}
