"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "./_fetch";
import type { PortfolioProjectRow } from "./types";

export type HomeProjectsScope = "all" | "sdm" | "none";

export type HomeProjectsResponse = {
  month: string;
  scope: HomeProjectsScope;
  projects: PortfolioProjectRow[];
};

export function useHomeProjects(month: string) {
  return useQuery<HomeProjectsResponse>({
    queryKey: ["home", "projects", month],
    queryFn: () =>
      apiGet<HomeProjectsResponse>("/home/projects", { query: { month } }),
    enabled: /^\d{4}-\d{2}$/.test(month),
    staleTime: 30_000,
  });
}
