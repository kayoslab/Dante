"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type {
  BenchSummary,
  PortfolioMonthly,
  PortfolioProjectRow,
} from "./types";

export type { PortfolioMonthly };
export type { PortfolioProjectRow };
export type { BenchSummary };

export function usePortfolioMonthly(month: string) {
  return useQuery<PortfolioMonthly>({
    // Keep in sync with app/reports/portfolio-rentability/page.tsx prefetch.
    queryKey: ["reports", "portfolio-rentability", "month", month],
    queryFn: async () => {
      return apiGet<PortfolioMonthly>(
        "/reports/portfolio-rentability/month",
        { query: { month } },
      );
    },
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
