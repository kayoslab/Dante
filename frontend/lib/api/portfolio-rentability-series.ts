"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";

export type PortfolioRentabilitySeriesPoint = {
  month: string;
  revenue: string;
  cost: string;
  margin: string;
  margin_pct: string | null;
  is_forecast: boolean;
};

export type PortfolioRentabilitySeries = {
  points: PortfolioRentabilitySeriesPoint[];
};

export function usePortfolioRentabilitySeries(
  from_month: string,
  to_month: string,
) {
  return useQuery<PortfolioRentabilitySeries>({
    // Keep in sync with app/reports/portfolio-rentability/page.tsx prefetch.
    queryKey: [
      "reports",
      "portfolio-rentability",
      "series",
      from_month,
      to_month,
    ],
    queryFn: () =>
      apiGet<PortfolioRentabilitySeries>(
        "/reports/portfolio-rentability/monthly-series",
        { query: { from_month, to_month } },
      ),
    enabled:
      /^\d{4}-\d{2}$/.test(from_month) && /^\d{4}-\d{2}$/.test(to_month),
    staleTime: 30_000,
  });
}
