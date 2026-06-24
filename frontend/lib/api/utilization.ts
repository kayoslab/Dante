"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type UtilizationGroupAggregate = {
  key: string;
  n_employees: number;
  loaded_cost: string;
  unallocated_cost: string;
  util_pct_eur: string | null;
  util_pct_headcount: string | null;
};

export type UtilizationMonthPoint = {
  month: string;
  is_forecast: boolean;
  totals: {
    n_employees: number;
    loaded_cost: string;
    unallocated_cost: string;
    util_pct_eur: string | null;
    util_pct_headcount: string | null;
    n_overbook: number;
  };
  by_team: UtilizationGroupAggregate[];
  by_role_tier: UtilizationGroupAggregate[];
};

export type UtilizationForecastDrivers = {
  from_date: string;
  to_date: string;
  projects_ending: Array<{
    project_id: number;
    project_name: string;
    customer_name: string;
    end_date: string;
    n_assignments: number;
    freeing_alloc_sum: string;
  }>;
  hires_starting: Array<{
    employee_id: number;
    who_name: string;
    hire_date: string;
    team: string | null;
    role_tier: string | null;
  }>;
};

export type UtilizationSeries = {
  points: UtilizationMonthPoint[];
  forecast_drivers: UtilizationForecastDrivers;
};

export function useUtilizationSeries(from_month: string, to_month: string) {
  return useQuery<UtilizationSeries>({
    queryKey: ["reports", "utilization", "series", from_month, to_month],
    queryFn: () =>
      apiGet<UtilizationSeries>("/reports/utilization/monthly-series", {
        query: { from_month, to_month },
      }),
    enabled:
      /^\d{4}-\d{2}$/.test(from_month) && /^\d{4}-\d{2}$/.test(to_month),
    staleTime: 30_000,
  });
}

export type UtilizationMonthDetail = {
  month: string;
  benched: Array<{
    employee_id: number;
    who_name: string;
    team: string | null;
    role_tier: string | null;
    loaded_cost: string;
    utilization_pct: string;
    unallocated_cost: string;
    bench_since_date: string | null;
    bench_since_days: number | null;
  }>;
  overbooked: Array<{
    employee_id: number;
    who_name: string;
    team: string | null;
    role_tier: string | null;
    loaded_cost: string;
    utilization_pct: string;
    overbook_pct: string;
  }>;
};

export function useUtilizationMonth(month: string) {
  return useQuery<UtilizationMonthDetail>({
    queryKey: ["reports", "utilization", "month", month],
    queryFn: () =>
      apiGet<UtilizationMonthDetail>("/reports/utilization/month", {
        query: { month },
      }),
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
