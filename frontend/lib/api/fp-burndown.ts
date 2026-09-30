"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type FpBurndownProject = {
  project_id: number;
  project_name: string;
  customer_id: number;
  customer_name: string;
  recognition_method: "tracked_hours" | "timeline" | "none";
  agreed_amount: string | null;
  time_budget_hours: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  as_of_date: string;
  tracked_hours: string;
  cumulative_cost: string;
  cumulative_recognized: string;
  tracked_pct: string | null;
  /** Future planned hours from as-of-date to planned_end (sum of
   * allocation × working_days × standard_daily_hours). Null for
   * projects without a time budget. */
  future_planned_hours: string | null;
  /** (tracked + future_planned) / time_budget — where we'll land if
   * current plans hold. The burn-bar tick renders here. */
  projected_pct: string | null;
  /** Working-day elapsed share of the planned window. Kept for
   * timeline-method projects only; tracked projects use projected_pct. */
  elapsed_pct: string | null;
  variance_pp: string | null;
  margin_erosion_pct: string | null;
  status:
    | "on_track"
    | "at_risk"
    | "time_exhausted"
    | "margin_negative"
    | "not_started"
    | "ended"
    | "no_rule";
  days_to_end: number | null;
};

export type FpBurndownMonth = {
  month: string;
  as_of_date: string;
  projects: FpBurndownProject[];
  summary: {
    n_active: number;
    n_margin_negative: number;
    n_time_exhausted: number;
    n_at_risk: number;
    total_agreed: string;
    total_recognized: string;
    total_cost: string;
  };
};

export function useFpBurndownMonth(month: string) {
  return useQuery<FpBurndownMonth>({
    // Keep in sync with app/reports/fp-burndown/page.tsx prefetch.
    queryKey: ["reports", "fp-burndown", "month", month],
    queryFn: () =>
      apiGet<FpBurndownMonth>("/reports/fp-burndown/month", {
        query: { month },
      }),
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
