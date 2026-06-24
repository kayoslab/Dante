"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type TeamMonthlySeriesPoint = {
  month: string;
  revenue: string;
  cost: string;
  margin: string;
  margin_pct: string | null;
  utilization_pct: string | null;
  is_forecast: boolean;
};

export type TeamMonthlySeries = {
  team: string;
  points: TeamMonthlySeriesPoint[];
};

export function useTeamMonthlySeries(
  slug: string,
  from_month: string,
  to_month: string,
) {
  return useQuery<TeamMonthlySeries>({
    queryKey: ["team", slug, "monthly-series", from_month, to_month],
    queryFn: () =>
      apiGet<TeamMonthlySeries>("/teams/{slug}/monthly-series", {
        path: { slug },
        query: { from_month, to_month },
      }),
    enabled:
      slug.length > 0 &&
      /^\d{4}-\d{2}$/.test(from_month) &&
      /^\d{4}-\d{2}$/.test(to_month),
    staleTime: 30_000,
  });
}

export type TeamMonthAssignment = {
  assignment_id: number | null;
  project_id: number | null;
  project_name: string | null;
  customer_name: string | null;
  allocation_pct: string | null;
  end_date: string | null;
  revenue: string | null;
  cost: string | null;
};

export type TeamMonthRosterRow = {
  employee_id: number;
  who_name: string;
  role_tier: string | null;
  utilization_pct: string;
  monthly_cost: string;
  monthly_revenue: string;
  monthly_margin: string;
  primary_assignment: TeamMonthAssignment | null;
  bench_since_days: number | null;
  ends_soon: { project: string; date: string } | null;
};

export type TeamMonthProjectMixRow = {
  project_id: number;
  project_name: string;
  revenue: string;
  cost: string;
  pct_of_revenue: string;
};

export type TeamMonthKpis = {
  revenue: string;
  cost: string;
  margin: string;
  margin_pct: string | null;
  avg_util_pct: string | null;
  bench_eur: string;
  n_full_bench: number;
  n_partial_bench: number;
  n_fully_utilized: number;
};

export type TeamMonthResponse = {
  month: string;
  is_current_month: boolean;
  n_members: number;
  kpis: TeamMonthKpis;
  roster: TeamMonthRosterRow[];
  project_mix: TeamMonthProjectMixRow[];
};

export function useTeamMonth(slug: string, month: string) {
  return useQuery<TeamMonthResponse>({
    queryKey: ["team", slug, "month", month],
    queryFn: () =>
      apiGet<TeamMonthResponse>("/teams/{slug}/month", {
        path: { slug },
        query: { month },
      }),
    enabled: slug.length > 0 && /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
