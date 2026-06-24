"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { GenderGapChart } from "@/components/salary/gender-gap-chart";
import { SalaryBandChart } from "@/components/salary/salary-band-chart";
import { SalaryOutliersList } from "@/components/salary/salary-outliers-list";
import {
  useGenderGap,
  useSalaryBands,
  useSalaryOutliers,
  type BandGrouping,
  type GapBasis,
  type GapGrouping,
} from "@/lib/api/salary-insights";
import { cn } from "@/lib/utils";

const BAND_GROUPINGS: { value: BandGrouping; label: string; hint: string }[] = [
  { value: "tier", label: "Role tier", hint: "junior / advanced / senior / expert" },
  { value: "team", label: "Team", hint: "curated team_user" },
  { value: "department", label: "Department", hint: "Personio department" },
];

const GAP_GROUPINGS: { value: GapGrouping; label: string }[] = [
  { value: "tier", label: "Role tier" },
  { value: "team", label: "Team" },
];

const GAP_BASES: { value: GapBasis; label: string; hint: string }[] = [
  { value: "fix", label: "Fix salary", hint: "fix_salary only" },
  { value: "total", label: "Total comp", hint: "fix + recurring + hourly, FTE-normalized" },
];

export function SalaryClient() {
  const [bandGrouping, setBandGrouping] = useState<BandGrouping>("tier");
  const [gapGrouping, setGapGrouping] = useState<GapGrouping>("tier");
  const [gapBasis, setGapBasis] = useState<GapBasis>("fix");

  const bands = useSalaryBands(bandGrouping);
  const outliers = useSalaryOutliers(bandGrouping);
  const gap = useGenderGap(gapGrouping, gapBasis);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Salary insights
        </h1>
        <p className="text-sm text-muted-foreground">
          All figures are monthly FTE-normalized EUR. Excludes multi-org and
          non-real employees. Restricted to admin + manager roles.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Salary bands</CardTitle>
            <Pills
              options={BAND_GROUPINGS}
              value={bandGrouping}
              onChange={setBandGrouping}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Box plot: whiskers = min / max, box = interquartile range (p25
            to p75), thick line = median.
          </p>
        </CardHeader>
        <CardContent>
          {bands.isLoading && <Skeleton className="h-60 w-full" />}
          {bands.isError && (
            <p className="text-sm text-red-600">
              {bands.error instanceof Error
                ? bands.error.message
                : "Failed to load"}
            </p>
          )}
          {bands.data && <SalaryBandChart rows={bands.data} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Outliers &amp; band exceedances</CardTitle>
          <p className="text-xs text-muted-foreground">
            Employees whose FTE-normalized salary
            {bandGrouping === "tier"
              ? " exceeds the max of a higher-ranked tier, or"
              : ""}
            {" "}sits above their own band's upper fence (p75 + 1.5·IQR).
            Click a name to open their profile.
          </p>
        </CardHeader>
        <CardContent>
          {outliers.isLoading && <Skeleton className="h-32 w-full" />}
          {outliers.isError && (
            <p className="text-sm text-red-600">
              {outliers.error instanceof Error
                ? outliers.error.message
                : "Failed to load"}
            </p>
          )}
          {outliers.data && <SalaryOutliersList rows={outliers.data} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Gender pay gap</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Pills
                options={GAP_GROUPINGS}
                value={gapGrouping}
                onChange={setGapGrouping}
              />
              <Pills
                options={GAP_BASES}
                value={gapBasis}
                onChange={setGapBasis}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Compares median salary across genders. Positive gap = males earn
            more. Tier-level controls for the role-mix bias that drives most
            team-level gaps.
          </p>
        </CardHeader>
        <CardContent>
          {gap.isLoading && <Skeleton className="h-60 w-full" />}
          {gap.isError && (
            <p className="text-sm text-red-600">
              {gap.error instanceof Error
                ? gap.error.message
                : "Failed to load"}
            </p>
          )}
          {gap.data && <GenderGapChart rows={gap.data} />}
        </CardContent>
      </Card>
    </div>
  );
}

function Pills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border bg-muted/30 p-0.5">
      {options.map((o) => (
        <Button
          key={o.value}
          variant="ghost"
          size="sm"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded px-2.5 text-xs",
            o.value === value && "bg-background shadow-sm",
          )}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}
