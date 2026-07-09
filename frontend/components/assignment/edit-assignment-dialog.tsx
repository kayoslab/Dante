"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Pencil } from "lucide-react";
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
import { useUpdateAssignment } from "@/lib/api/assignments";
import { optionalPositiveNumber, requiredPositiveNumber } from "@/lib/zod-helpers";
import { useProject, type ProjectAssignment } from "@/lib/api/projects";

const schema = z
  .object({
    profile: z.string().optional(),
    allocation_pct: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
      z.number().gt(0).max(1.5),
    ),
    start_date: z.string().min(1, "required"),
    end_date: z.string().optional(),
    daily_rate_override_eur: optionalPositiveNumber,
    daily_cost_override_eur: optionalPositiveNumber,
    notes: z.string().optional(),
  })
  .refine(
    (v) =>
      !v.end_date || new Date(v.end_date) >= new Date(v.start_date),
    {
      path: ["end_date"],
      message: "end date must be on or after start date",
    },
  );
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

type Props = {
  projectId: number;
  assignment: ProjectAssignment;
};

export function EditAssignmentDialog({ projectId, assignment }: Props) {
  const [open, setOpen] = useState(false);
  const update = useUpdateAssignment(projectId);
  const { data: project } = useProject(projectId);
  const profileOptions = Array.from(
    new Set(
      [
        ...(project?.rates ?? []).map((r) => r.profile),
        ...(project?.framework_rates ?? []).map((r) => r.profile),
      ].filter(Boolean),
    ),
  ).sort();
  // The current assignment's profile may not be in the project's current rate
  // list (e.g. rate was deleted after the assignment was created). Surface it
  // so the user can keep editing without losing their selection.
  const dropdownOptions =
    assignment.profile && !profileOptions.includes(assignment.profile)
      ? [...profileOptions, assignment.profile]
      : profileOptions;

  const defaults: FormInput = {
    profile: assignment.profile ?? "",
    allocation_pct: assignment.allocation_pct,
    start_date: assignment.start_date ?? "",
    end_date: assignment.end_date ?? "",
    daily_rate_override_eur: assignment.daily_rate_override_eur ?? undefined,
    daily_cost_override_eur: assignment.daily_cost_override_eur ?? undefined,
    notes: assignment.notes ?? "",
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) reset(defaults);
  };

  const onSubmit = handleSubmit(async (values) => {
    try {
      await update.mutateAsync({
        assignment_id: assignment.assignment_id,
        body: {
          profile: values.profile ?? null,
          allocation_pct: values.allocation_pct,
          start_date: values.start_date,
          end_date: values.end_date || null,
          daily_rate_override_eur: values.daily_rate_override_eur ?? null,
          daily_cost_override_eur: values.daily_cost_override_eur ?? null,
          notes: values.notes ?? null,
        },
      });
      toast.success("Assignment updated");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Pencil className="h-4 w-4" />
          </Button>
        }
      />
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>
              Edit assignment — {assignment.who_name}
            </DialogTitle>
            <DialogDescription>
              Entity ({assignment.kind}) and project can't be changed — delete
              and re-create if you need to move the allocation.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="profile">Profile</Label>
              <select
                id="profile"
                {...register("profile")}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="">
                  {assignment.kind === "employee"
                    ? "— use role_tier —"
                    : "— select a profile —"}
                </option>
                {dropdownOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {dropdownOptions.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No rates defined on this project yet.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="allocation_pct">Allocation (0–1.5)</Label>
                <Input
                  id="allocation_pct"
                  type="number"
                  step="any"
                  min="0"
                  max="1.5"
                  {...register("allocation_pct")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="daily_rate_override_eur">Rate override €/d</Label>
                <Input
                  id="daily_rate_override_eur"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register("daily_rate_override_eur")}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="start_date">Start</Label>
                <Input
                  id="start_date"
                  type="date"
                  {...register("start_date")}
                />
                {errors.start_date && (
                  <p className="text-sm text-red-600">
                    {errors.start_date.message as string}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="end_date">End</Label>
                <Input id="end_date" type="date" {...register("end_date")} />
                {errors.end_date && (
                  <p className="text-sm text-red-600">
                    {errors.end_date.message as string}
                  </p>
                )}
              </div>
            </div>
            {assignment.kind === "freelancer" && (
              <div className="space-y-1.5">
                <Label htmlFor="daily_cost_override_eur">
                  Cost override €/d (freelancers)
                </Label>
                <Input
                  id="daily_cost_override_eur"
                  type="number"
                  step="0.01"
                  min="0"
                  {...register("daily_cost_override_eur")}
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={2} {...register("notes")} />
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
            <Button type="submit" disabled={isSubmitting || !isDirty}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
