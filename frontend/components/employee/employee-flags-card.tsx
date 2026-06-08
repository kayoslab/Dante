"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

import {
  useUpdateEmployeeFlags,
  type EmployeeDetail,
} from "@/lib/api/employees";
import { useTeams } from "@/lib/api/teams";

type Props = {
  employee: EmployeeDetail;
};

export function EmployeeFlagsCard({ employee }: Props) {
  const update = useUpdateEmployeeFlags(employee.employee_id);
  const teams = useTeams();

  async function toggle(
    field:
      | "is_real_employee"
      | "is_project_contributing"
      | "is_multi_org",
    next: boolean,
  ) {
    try {
      await update.mutateAsync({ [field]: next });
      toast.success("Flag updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  async function onTeamChange(value: string) {
    try {
      if (value === "") {
        await update.mutateAsync({ clear_team: true });
        toast.success("Team cleared");
      } else {
        await update.mutateAsync({ team_user: value });
        toast.success(`Assigned to ${value}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  // NULL → treated as TRUE for `is_real_employee` / `is_project_contributing`,
  // FALSE for `is_multi_org`. Switches reflect the effective value so flipping
  // them sets an explicit boolean (which the calendar / analytics SQL pick up).
  const realEffective = employee.is_real_employee ?? true;
  const contribEffective = employee.is_project_contributing ?? true;
  const multiEffective = employee.is_multi_org ?? false;

  const disabled = update.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Analytics flags</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5 border-b pb-3">
          <Label htmlFor="team-select" className="text-sm font-medium">
            Team
          </Label>
          <select
            id="team-select"
            value={employee.team ?? ""}
            onChange={(e) => onTeamChange(e.target.value)}
            disabled={disabled || teams.isLoading}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
          >
            <option value="">— no team —</option>
            {teams.data?.map((t) => (
              <option key={t.team_name} value={t.team_name}>
                {t.team_name}
              </option>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Curated team. Used for grouping in bench / portfolio /
            employee directory filters. Manage the list under Settings →
            Teams.
          </p>
        </div>
        <FlagRow
          label="Real employee"
          description="Off = external (tax advisor, shared inbox). Excludes from all rollups."
          checked={realEffective}
          explicit={employee.is_real_employee !== null && employee.is_real_employee !== undefined}
          disabled={disabled}
          onChange={(v) => toggle("is_real_employee", v)}
        />
        <FlagRow
          label="Project contributing"
          description="Off = Sales/HR/Backoffice. Excludes from bench/allocation math."
          checked={contribEffective}
          explicit={
            employee.is_project_contributing !== null &&
            employee.is_project_contributing !== undefined
          }
          disabled={disabled}
          onChange={(v) => toggle("is_project_contributing", v)}
        />
        <FlagRow
          label="Multi-org"
          description="On = co-employed across countries; partial-pay outlier exclusion."
          checked={multiEffective}
          explicit={employee.is_multi_org !== null && employee.is_multi_org !== undefined}
          disabled={disabled}
          onChange={(v) => toggle("is_multi_org", v)}
        />
        {update.isPending && (
          <Skeleton className="h-1 w-full opacity-50" />
        )}
      </CardContent>
    </Card>
  );
}

function FlagRow({
  label,
  description,
  checked,
  explicit,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  explicit: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-3 last:border-b-0 last:pb-0">
      <div className="space-y-1">
        <Label className="text-sm font-medium">
          {label}
          {!explicit && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              (default)
            </span>
          )}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="mt-0.5"
      />
    </div>
  );
}
