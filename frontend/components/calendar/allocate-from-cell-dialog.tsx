"use client";

import { useEffect, useMemo } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import { APIError } from "@/lib/api/types";
import { calendarKeys } from "@/lib/api/calendar";
import { projectKeys, useProject, useProjects } from "@/lib/api/projects";
import { createAssignmentAction } from "@/lib/actions/assignment";
import {
  optionalPositiveNumber,
  requiredPositiveNumber,
} from "@/lib/zod-helpers";

const schema = z
  .object({
    project_id: z.preprocess(
      (v) => (v === "" || v === null || v === undefined ? undefined : Number(v)),
      z.number().int().positive(),
    ),
    profile: z.string().optional(),
    allocation_pct: requiredPositiveNumber.refine((n) => n <= 1.5, {
      message: "must be ≤ 1.5",
    }),
    start_date: z.string().min(1, "required"),
    end_date: z.string().optional(),
    daily_rate_override_eur: optionalPositiveNumber,
    notes: z.string().optional(),
  })
  .refine(
    (v) => !v.end_date || new Date(v.end_date) >= new Date(v.start_date),
    { path: ["end_date"], message: "end must be on or after start" },
  );
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employeeId: number;
  employeeName: string;
  startDate: string;
};

export function AllocateFromCellDialog({
  open,
  onOpenChange,
  employeeId,
  employeeName,
  startDate,
}: Props) {
  const qc = useQueryClient();
  const projectsQuery = useProjects("active");

  const defaults: FormInput = useMemo(
    () => ({
      project_id: undefined,
      profile: "",
      allocation_pct: 1.0,
      start_date: startDate,
      end_date: "",
      daily_rate_override_eur: undefined,
      notes: "",
    }),
    [startDate],
  );

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { errors, isSubmitting, isValid },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: defaults,
  });

  // Watch the selected project so we can fetch its rates and populate the
  // profile dropdown. Profile choices change as the user picks a project.
  const selectedProjectId = useWatch({ control, name: "project_id" });
  const projectIdNum = Number(selectedProjectId);
  const { data: selectedProject } = useProject(
    Number.isFinite(projectIdNum) && projectIdNum > 0 ? projectIdNum : 0,
  );
  const profileOptions = Array.from(
    new Set(
      [
        ...(selectedProject?.rates ?? []).map((r) => r.profile),
        ...(selectedProject?.framework_rates ?? []).map((r) => r.profile),
      ].filter(Boolean),
    ),
  ).sort();

  // Re-seed defaults whenever the dialog (re)opens for a new employee/date.
  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const create = useMutation({
    mutationFn: async (values: FormOutput) => {
      const body = {
        employee_id: employeeId,
        freelancer_id: null,
        project_id: values.project_id,
        profile: values.profile || null,
        allocation_pct: values.allocation_pct,
        start_date: values.start_date,
        end_date: values.end_date || null,
        daily_rate_override_eur: values.daily_rate_override_eur ?? null,
        daily_cost_override_eur: null,
        notes: values.notes || null,
      };
      const r = await createAssignmentAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return { assignment: r.data, project_id: values.project_id };
    },
    onSuccess: ({ project_id }) => {
      qc.invalidateQueries({ queryKey: calendarKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await create.mutateAsync(values);
      toast.success(`${employeeName} allocated`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Allocate {employeeName}</DialogTitle>
            <DialogDescription>
              Pick a project and confirm the dates and allocation. Date is
              pre-filled from the cell you clicked.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="project_id">Project</Label>
              <select
                id="project_id"
                {...register("project_id")}
                disabled={projectsQuery.isLoading}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                defaultValue=""
              >
                <option value="" disabled>
                  {projectsQuery.isLoading ? "Loading…" : "Select a project"}
                </option>
                {projectsQuery.data?.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.customer_name} / {p.name}
                    {p.billing_model === "fixed_price" ? " (FP)" : ""}
                  </option>
                ))}
              </select>
              {errors.project_id && (
                <p className="text-sm text-red-600">
                  {errors.project_id.message as string}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="profile">Profile (optional)</Label>
              <select
                id="profile"
                {...register("profile")}
                disabled={!selectedProjectId || !selectedProject}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
              >
                <option value="">— use role_tier —</option>
                {profileOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {!!selectedProjectId && profileOptions.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No rates defined on this project yet.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="allocation_pct">Allocation (0.1–1.5)</Label>
                <Input
                  id="allocation_pct"
                  type="number"
                  step="0.1"
                  min="0.1"
                  max="1.5"
                  {...register("allocation_pct")}
                />
                {errors.allocation_pct && (
                  <p className="text-sm text-red-600">
                    {errors.allocation_pct.message as string}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rate_override">Rate override €/d</Label>
                <Input
                  id="rate_override"
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
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="end_date">End (optional)</Label>
                <Input id="end_date" type="date" {...register("end_date")} />
                {errors.end_date && (
                  <p className="text-sm text-red-600">
                    {errors.end_date.message as string}
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" rows={2} {...register("notes")} />
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !isValid}>
              {isSubmitting ? "Allocating…" : "Allocate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
