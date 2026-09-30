"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { ConsultantTrackedHoursRow, TrackedHoursMonth } from "./types";

export type { TrackedHoursMonth };
export type { ConsultantTrackedHoursRow };

// Key shape `["tracked-hours", month, team ?? null]` is prefetched server-side
// in app/reports/time/page.tsx (month = current, team = null) — keep in sync.
export function useTrackedHours(month: string, team?: string) {
  return useQuery<TrackedHoursMonth>({
    queryKey: ["tracked-hours", month, team ?? null],
    queryFn: async () => {
      return apiGet<TrackedHoursMonth>("/tracked-hours", { query: { month, team } });
    },
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
