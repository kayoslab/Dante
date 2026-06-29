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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

import { useCreateAssignment, useEstimate } from "@/lib/api/assignments";
import { useEmployees } from "@/lib/api/employees";
import { useFreelancers } from "@/lib/api/freelancers";
import { useProject } from "@/lib/api/projects";
import { formatEUR } from "@/lib/format";

const optInt = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  },
  z.number().int().positive().optional(),
);
const optPosNum = z.preprocess(
  (v) => {
    if (v === "" || v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  },
  z.number().positive().optional(),
);

const schema = z
  .object({
    kind: z.enum(["employee", "freelancer"]),
    employee_id: optInt,
    freelancer_id: optInt,
    profile: z.string().optional(),
    allocation_pct: z.coerce.number().min(0.1).max(1.5),
    start_date: z.string().min(1, "required"),
    end_date: z.string().optional(),
    daily_rate_override_eur: optPosNum,
    daily_cost_override_eur: optPosNum,
    notes: z.string().optional(),
  })
  .refine(
    (v) => (v.kind === "employee" ? !!v.employee_id : !!v.freelancer_id),
    { message: "select an entity", path: ["employee_id"] },
  )
  .refine(
    (v) => v.kind !== "freelancer" || !!v.profile,
    {
      message: "freelancer needs a profile (no role_tier fallback)",
      path: ["profile"],
    },
  );
type FormInput = z.input<typeof schema>;
type FormOutput = z.output<typeof schema>;

export function AddAssignmentDialog({ project_id }: { project_id: number }) {
  const [open, setOpen] = useState(false);
  // Default off — the common case is allocating someone currently on the
  // payroll. Toggle on when back-dating an assignment for someone who's
  // already left (end-of-quarter billing reconciliation, late PO that
  // covers a window the consultant has since rolled off, etc.). Status
  // !== "active" lights up the "(former)" suffix on the option label so
  // they aren't picked by mistake when the toggle is on.
  const [includeFormer, setIncludeFormer] = useState(false);
  const create = useCreateAssignment(project_id);
  const { data: freelancers = [] } = useFreelancers();
  // Project-contributing real employees. include_excluded:false drops
  // service-account / shared mailbox rows from Personio. Status filter
  // is opt-in via the Switch — without it we fetch all statuses and
  // distinguish them in the option label.
  const { data: employeesRaw = [] } = useEmployees({
    status: includeFormer ? undefined : "active",
    include_excluded: false,
  });
  const employeeOptions = employeesRaw
    .filter((e) => e.is_project_contributing !== false)
    .map((e) => ({
      employee_id: e.employee_id,
      label:
        `${e.last_name ?? ""}, ${e.first_name ?? ""}`.replace(/^, |, $/g, "") ||
        `Employee #${e.employee_id}`,
      role_tier: e.role_tier ?? null,
      is_former: e.status !== "active",
    }))
    .sort((a, b) => {
      // Active first, then former — keeps the common case at the top of
      // the list. Within each group, alphabetical by "Last, First".
      if (a.is_former !== b.is_former) return a.is_former ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  const { data: project } = useProject(project_id);
  // Unique profile names from the project's rate sheet — drives the dropdown.
  // Sorted for stable order; empty array if rates haven't loaded yet.
  // Union project-level rates (overrides) with framework-inherited rates so
  // a project automatically sees framework profiles without manual re-entry.
  // Set deduplicates on profile name — project rate identity wins implicitly
  // because the rate resolver checks project_rate before framework_rate.
  const profileOptions = Array.from(
    new Set(
      [
        ...(project?.rates ?? []).map((r) => r.profile),
        ...(project?.framework_rates ?? []).map((r) => r.profile),
      ].filter(Boolean),
    ),
  ).sort();

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema),
    defaultValues: { kind: "employee", allocation_pct: 1.0 },
  });

  const kind = watch("kind");
  const employee_id_raw = watch("employee_id");
  const freelancer_id_raw = watch("freelancer_id");
  const profile = watch("profile");
  const allocation_pct_raw = watch("allocation_pct");
  const rate_override_raw = watch("daily_rate_override_eur");
  const cost_override_raw = watch("daily_cost_override_eur");

  const toNum = (v: unknown): number | null => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const allocation_pct = toNum(allocation_pct_raw);
  const employee_id = toNum(employee_id_raw);
  const freelancer_id = toNum(freelancer_id_raw);
  const rate_override = toNum(rate_override_raw);
  const cost_override = toNum(cost_override_raw);

  // Live estimate — only when entity + valid allocation are present
  const canEstimate =
    !!project_id &&
    allocation_pct !== null &&
    allocation_pct > 0 &&
    allocation_pct <= 1.5 &&
    ((kind === "employee" && employee_id !== null) ||
      (kind === "freelancer" && freelancer_id !== null && !!profile));

  const estimate = useEstimate(
    canEstimate
      ? {
          project_id,
          allocation_pct: allocation_pct!,
          employee_id: kind === "employee" ? employee_id : null,
          freelancer_id: kind === "freelancer" ? freelancer_id : null,
          profile: profile || null,
          rate_override,
          cost_override,
          as_of: null,
        }
      : null,
  );

  const onSubmit = handleSubmit(async (values) => {
    try {
      await create.mutateAsync({
        project_id,
        employee_id: values.kind === "employee" ? values.employee_id ?? null : null,
        freelancer_id:
          values.kind === "freelancer" ? values.freelancer_id ?? null : null,
        profile: values.profile || null,
        allocation_pct: values.allocation_pct,
        start_date: values.start_date,
        end_date: values.end_date || null,
        daily_rate_override_eur: values.daily_rate_override_eur ?? null,
        daily_cost_override_eur: values.daily_cost_override_eur ?? null,
        notes: values.notes || null,
      });
      toast.success("Assignment created");
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
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Allocate
          </Button>
        }
      />
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader>
            <DialogTitle>Allocate entity to project</DialogTitle>
            <DialogDescription>
              The margin estimate updates live as you change fields.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid grid-cols-5 gap-4 py-4">
            {/* Left: form */}
            <div className="col-span-3 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="kind">Entity</Label>
                <select
                  id="kind"
                  {...register("kind")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                >
                  <option value="employee">Employee</option>
                  <option value="freelancer">Freelancer</option>
                </select>
              </div>

              {kind === "employee" ? (
                <div className="space-y-1.5">
                  <Label htmlFor="employee_id">Employee</Label>
                  <select
                    id="employee_id"
                    {...register("employee_id")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    defaultValue=""
                  >
                    <option value="">— select —</option>
                    {employeeOptions.map((e) => (
                      <option key={e.employee_id} value={e.employee_id}>
                        {e.label}
                        {e.role_tier ? ` · ${e.role_tier}` : ""}
                        {e.is_former ? " (former)" : ""}
                      </option>
                    ))}
                  </select>
                  <div className="flex items-center justify-between pt-1">
                    <Label
                      htmlFor="include_former"
                      className="text-xs font-normal text-muted-foreground"
                    >
                      Include former employees
                    </Label>
                    <Switch
                      id="include_former"
                      checked={includeFormer}
                      onCheckedChange={setIncludeFormer}
                    />
                  </div>
                  {employeeOptions.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No {includeFormer ? "" : "active "}project-contributing
                      employees on file — check Personio sync.
                    </p>
                  )}
                  {errors.employee_id && (
                    <p className="text-sm text-red-600">
                      {errors.employee_id.message}
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  <Label htmlFor="freelancer_id">Freelancer</Label>
                  <select
                    id="freelancer_id"
                    {...register("freelancer_id")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                    defaultValue=""
                  >
                    <option value="">— select —</option>
                    {freelancers.map((f) => (
                      <option key={f.freelancer_id} value={f.freelancer_id}>
                        {f.name} (€{Number(f.daily_cost_eur).toFixed(0)}/d)
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="profile">
                  Profile {kind === "freelancer" && <span className="text-red-600">*</span>}
                </Label>
                <select
                  id="profile"
                  {...register("profile")}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  defaultValue=""
                >
                  <option value="">
                    {kind === "employee"
                      ? "— use role_tier —"
                      : "— select a profile —"}
                  </option>
                  {profileOptions.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                {profileOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No rates defined on this project yet — add one to populate
                    the dropdown.
                  </p>
                )}
                {errors.profile && (
                  <p className="text-sm text-red-600">{errors.profile.message}</p>
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
                  {errors.start_date && (
                    <p className="text-sm text-red-600">
                      {errors.start_date.message}
                    </p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="end_date">End (optional)</Label>
                  <Input id="end_date" type="date" {...register("end_date")} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes</Label>
                <Textarea id="notes" rows={2} {...register("notes")} />
              </div>
            </div>

            {/* Right: live estimate */}
            <div className="col-span-2">
              <Label className="mb-2 block">Live margin estimate</Label>
              <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1.5">
                {!canEstimate && (
                  <p className="text-muted-foreground">
                    Fill the entity, profile, and allocation to see the estimate.
                  </p>
                )}
                {canEstimate && estimate.isLoading && (
                  <p className="text-muted-foreground">Estimating…</p>
                )}
                {canEstimate && estimate.isError && (
                  <p className="text-red-600">
                    {estimate.error instanceof Error
                      ? estimate.error.message
                      : "estimate failed"}
                  </p>
                )}
                {canEstimate && estimate.data && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Profile</span>
                      <span>{estimate.data.effective_profile ?? "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Rate</span>
                      <span className="tabular-nums">
                        {formatEUR(estimate.data.effective_daily_rate_eur)}/d{" "}
                        <span className="text-xs text-muted-foreground">
                          ({estimate.data.rate_source})
                        </span>
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Revenue/mo</span>
                      <span className="tabular-nums">
                        {formatEUR(estimate.data.monthly_revenue)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cost/mo</span>
                      <span className="tabular-nums">
                        {formatEUR(estimate.data.monthly_cost_pre_alloc)}
                      </span>
                    </div>
                    <div className="flex justify-between border-t pt-1.5 font-medium">
                      <span>Margin/mo</span>
                      <span className="tabular-nums">
                        {formatEUR(estimate.data.monthly_gross_margin)}{" "}
                        {estimate.data.monthly_gross_margin_pct && (
                          <span className="text-xs text-muted-foreground">
                            ({Number(estimate.data.monthly_gross_margin_pct).toFixed(1)}%)
                          </span>
                        )}
                      </span>
                    </div>
                    {estimate.data.rate_source === "unset" && (
                      <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                        ⚠ no rate for this profile — set one or use rate-override.
                      </p>
                    )}
                  </>
                )}
              </div>
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
              {isSubmitting ? "Allocating…" : "Allocate"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
