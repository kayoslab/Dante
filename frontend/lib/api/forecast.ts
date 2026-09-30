"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

/** Planned billable / available for a forward month. */
export type ForecastMonthPlan = {
  month: string; // YYYY-MM
  planned_billable_h: number;
  available_h: number;
};

/** Performed-vs-planned rollup (total / team / role / consultant). Current-month
 * hours; where the month is still running, actuals are month-to-date. */
export type ForecastRow = {
  key: string;
  n_employees: number;
  capacity_h: number;
  available_h: number;
  vacation_h: number;
  planned_billable_h: number;
  actual_billable_h: number;
  actual_nonbillable_h: number;
  bench_h: number;
  over_h: number;
  utilization_pct: number | null; // actual billable ÷ available
  bench_pct: number | null; // bench ÷ available
  delivery_pct: number | null; // actual billable ÷ planned billable to-date
  next: ForecastMonthPlan[];
};

export type ForecastConsultantRow = ForecastRow & {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
};

/** Per-month partition of a team's paid capacity. billable_delivered +
 * allocated_not_billed + bench + vacation = capacity (over shown separately). */
export type CapacityBucket = {
  capacity_h: number;
  available_h: number;
  vacation_h: number;
  on_project_h: number; // engaged (on-project) capacity ≈ billable allocation
  bench_h: number;
  over_h: number;
};

export type CapacityTeamRow = {
  key: string; // "__total__" | team name
  months: CapacityBucket[];
};

export type CapacityBreakdown = {
  months: { month: string; working_days: number }[];
  totals: CapacityTeamRow;
  by_team: CapacityTeamRow[];
};

export type ForecastReport = {
  generated_for: string; // YYYY-MM-DD
  current_month: string; // YYYY-MM
  next_months: string[];
  totals: ForecastRow;
  by_team: ForecastRow[];
  by_role_tier: ForecastRow[];
  by_consultant: ForecastConsultantRow[];
  capacity: CapacityBreakdown;
};

export function useForecast() {
  return useQuery<ForecastReport>({
    // Keep in sync with app/reports/forecast/page.tsx prefetch.
    queryKey: ["reports", "forecast"],
    queryFn: () => apiGet<ForecastReport>("/reports/forecast"),
    staleTime: 30_000,
  });
}
