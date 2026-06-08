"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { MonthlySeries, MonthlySeriesPoint } from "./types";

export type { MonthlySeries };
export type { MonthlySeriesPoint };

export function useProjectMonthlySeries(
  project_id: number,
  from_month: string,
  to_month: string,
) {
  return useQuery<MonthlySeries>({
    queryKey: [
      "project",
      project_id,
      "monthly-series",
      from_month,
      to_month,
    ],
    queryFn: async () => {
      return apiGet<MonthlySeries>("/projects/{project_id}/monthly-series", {
            path: { project_id },
            query: { from_month, to_month },
          });
    },
    enabled:
      project_id > 0 &&
      /^\d{4}-\d{2}$/.test(from_month) &&
      /^\d{4}-\d{2}$/.test(to_month),
    staleTime: 30_000,
  });
}
