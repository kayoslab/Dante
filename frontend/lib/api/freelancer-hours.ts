"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteFreelancerHoursAction,
  setFreelancerHoursAction,
} from "@/lib/actions/freelancer-hours";
import type { FreelancerHoursEntry } from "@/lib/db/queries/freelancer-hours";

import { apiGet } from "./_fetch";
import { projectKeys } from "./keys";
import { APIError } from "./types";

export type { FreelancerHoursEntry };

export function useFreelancerHours(project_id: number) {
  return useQuery<FreelancerHoursEntry[]>({
    queryKey: [...projectKeys.detail(project_id), "freelancer-hours"],
    queryFn: async () =>
      apiGet<FreelancerHoursEntry[]>(
        "/projects/{project_id}/freelancer-hours",
        { path: { project_id } },
      ),
  });
}

type SetCellArgs = {
  assignment_id: number;
  year_month: string;
  hours_decimal: number;
};

export function useSetFreelancerHours(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: SetCellArgs) => {
      const r = await setFreelancerHoursAction(args);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: [...projectKeys.detail(project_id), "freelancer-hours"],
      });
      // Cost numbers depend on freelancer hours — bust monthly/economics too.
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useDeleteFreelancerHours(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { assignment_id: number; year_month: string }) => {
      const r = await deleteFreelancerHoursAction(args);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: [...projectKeys.detail(project_id), "freelancer-hours"],
      });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}
