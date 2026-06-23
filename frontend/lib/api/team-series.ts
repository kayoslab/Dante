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
