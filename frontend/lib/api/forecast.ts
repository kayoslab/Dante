"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type ForecastMonthPlan = {
  month: string; // YYYY-MM
  planned_hours: number;
  projected_actual_hours: number | null;
};

export type ForecastRow = {
  key: string;
  n_employees: number;
  planned_hours: number;
  planned_to_date_hours: number;
  actual_hours: number;
  actual_billable_hours: number;
  realization_pct: number | null;
  assumed_full_hours: number | null;
  next: ForecastMonthPlan[];
};

export type ForecastConsultantRow = ForecastRow & {
  employee_id: number;
  who_name: string;
  team: string | null;
  role_tier: string | null;
};

export type CapacityBucket = {
  allocation_h: number; // allocated (capped at available); alloc + bench = available
  vacation_h: number;
  intercontract_h: number; // bench
  overbook_h: number; // planned beyond available
  available_h: number; // capacity − vacation (base for alloc/bench %)
  capacity_h: number; // total paid capacity (base for vacation %)
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
    queryKey: ["reports", "forecast"],
    queryFn: () => apiGet<ForecastReport>("/reports/forecast"),
    staleTime: 30_000,
  });
}
