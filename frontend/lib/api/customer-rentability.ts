"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type CustomerRentabilitySeriesPoint = {
  month: string;
  is_forecast: boolean;
  top_5_share_pct: string | null;
  customers: Array<{
    customer_id: number;
    customer_name: string;
    margin: string;
    revenue: string;
  }>;
};

export type CustomerRentabilitySeries = {
  points: CustomerRentabilitySeriesPoint[];
  /** Top-5 customers by aggregate margin over the actual months in the
   * window. Used by the stacked bar chart for stable colors. */
  top_customers: Array<{ customer_id: number; customer_name: string }>;
};

export function useCustomerRentabilitySeries(
  from_month: string,
  to_month: string,
) {
  return useQuery<CustomerRentabilitySeries>({
    // Keep in sync with app/reports/customer-rentability/page.tsx prefetch.
    queryKey: [
      "reports",
      "customer-rentability",
      "series",
      from_month,
      to_month,
    ],
    queryFn: () =>
      apiGet<CustomerRentabilitySeries>(
        "/reports/customer-rentability/monthly-series",
        { query: { from_month, to_month } },
      ),
    enabled:
      /^\d{4}-\d{2}$/.test(from_month) && /^\d{4}-\d{2}$/.test(to_month),
    staleTime: 30_000,
  });
}

export type CustomerRentabilityMonth = {
  month: string;
  ending_window: { from: string; to: string };
  customers: Array<{
    customer_id: number;
    customer_name: string;
    n_projects: number;
    revenue: string;
    cost: string;
    margin: string;
    margin_pct: string | null;
  }>;
  concentration: {
    n_positive_contributors: number;
    total_positive_margin: string;
    top_1_share_pct: string;
    top_5_share_pct: string;
    n_customers_above_10pct: number;
    hhi: string;
  } | null;
  ending_projects: Array<{
    customer_id: number;
    customer_name: string;
    project_id: number;
    project_name: string;
    project_ends_date: string;
  }>;
};

export function useCustomerRentabilityMonth(month: string) {
  return useQuery<CustomerRentabilityMonth>({
    // Keep in sync with app/reports/customer-rentability/page.tsx prefetch.
    queryKey: ["reports", "customer-rentability", "month", month],
    queryFn: () =>
      apiGet<CustomerRentabilityMonth>("/reports/customer-rentability/month", {
        query: { month },
      }),
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
