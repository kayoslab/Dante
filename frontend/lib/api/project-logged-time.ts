"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { LoggedTimeConsultantRow, ProjectLoggedTimeSummary } from "./types";

export type { ProjectLoggedTimeSummary };
export type { LoggedTimeConsultantRow };

export function useProjectLoggedTimeSummary(project_id: number) {
  return useQuery<ProjectLoggedTimeSummary>({
    queryKey: ["project", project_id, "logged-time-summary"],
    queryFn: async () => {
      return apiGet<ProjectLoggedTimeSummary>("/projects/{project_id}/logged-time-summary", { path: { project_id } });
    },
    enabled: project_id > 0,
    staleTime: 30_000,
  });
}
