"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { CalendarCell, CalendarDay, CalendarEmployee, CalendarPayload } from "./types";

export type { CalendarPayload };
export type { CalendarDay };
export type { CalendarEmployee };
export type { CalendarCell };

export const calendarKeys = {
  all: ["calendar"] as const,
  window: (start: string, end: string, includeNonContrib: boolean) =>
    [...calendarKeys.all, { start, end, includeNonContrib }] as const,
};

export function useCalendar(
  start: string,
  end: string,
  includeNonContributing = false,
) {
  return useQuery<CalendarPayload>({
    queryKey: calendarKeys.window(start, end, includeNonContributing),
    queryFn: async () => {
      return apiGet<CalendarPayload>("/calendar", {
          query: {
            start,
            end,
            include_non_contributing: includeNonContributing,
          },
        });
    },
    // Calendar windows are large; only refetch when user actively returns.
    staleTime: 60_000,
    // Keep previous data so range extensions (infinite scroll, prev/next month)
    // don't flash the skeleton — only the in-grid "loading more" footer shows.
    placeholderData: keepPreviousData,
  });
}
