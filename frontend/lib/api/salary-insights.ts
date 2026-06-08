"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { GenderGapRow, SalaryBandRow } from "./types";

export type { SalaryBandRow };
export type { GenderGapRow };

export type BandGrouping = "tier" | "team" | "department";
export type GapGrouping = "tier" | "team";
export type GapBasis = "fix" | "total";

export function useSalaryBands(grouping: BandGrouping) {
  return useQuery<SalaryBandRow[]>({
    queryKey: ["salary", "bands", grouping],
    queryFn: async () => {
      return apiGet<SalaryBandRow[]>("/salary/bands", { query: { grouping } });
    },
    staleTime: 60_000,
  });
}

export function useGenderGap(grouping: GapGrouping, basis: GapBasis) {
  return useQuery<GenderGapRow[]>({
    queryKey: ["salary", "gender-gap", grouping, basis],
    queryFn: async () => {
      return apiGet<GenderGapRow[]>("/salary/gender-gap", { query: { grouping, basis } });
    },
    staleTime: 60_000,
  });
}
