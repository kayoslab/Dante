"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { FreelancerCreate, FreelancerDetail, FreelancerListItem, FreelancerMonthlyAssignmentRow, FreelancerMonthlyBreakdown, FreelancerMonthlySeries, FreelancerMonthlySeriesPoint, FreelancerUpdate } from "./types";
import { APIError } from "./types";
import {
  createFreelancerAction,
  deleteFreelancerAction,
  updateFreelancerAction,
} from "@/lib/actions/freelancer";

export type { FreelancerListItem };
export type { FreelancerDetail };
export type { FreelancerCreate };
export type { FreelancerUpdate };
export type { FreelancerMonthlyBreakdown };
export type { FreelancerMonthlyAssignmentRow };
export type { FreelancerMonthlySeries };
export type { FreelancerMonthlySeriesPoint };

import { freelancerKeys } from "./keys";
export { freelancerKeys };

export function useFreelancers(status?: string) {
  return useQuery<FreelancerListItem[]>({
    queryKey: freelancerKeys.list(status),
    queryFn: async () => {
      return apiGet<FreelancerListItem[]>("/freelancers", { query: status ? { status } : {} });
    },
  });
}

export function useFreelancer(freelancer_id: number) {
  return useQuery<FreelancerDetail>({
    queryKey: freelancerKeys.detail(freelancer_id),
    queryFn: async () => {
      return apiGet<FreelancerDetail>("/freelancers/{freelancer_id}", { path: { freelancer_id } });
    },
  });
}

export function useCreateFreelancer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: FreelancerCreate) => {
      const r = await createFreelancerAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: freelancerKeys.all });
    },
  });
}

export function useUpdateFreelancer(freelancer_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: FreelancerUpdate) => {
      const r = await updateFreelancerAction(freelancer_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: freelancerKeys.all });
      qc.invalidateQueries({ queryKey: freelancerKeys.detail(freelancer_id) });
    },
  });
}

export function useFreelancerMonthly(freelancer_id: number, month: string) {
  return useQuery<FreelancerMonthlyBreakdown>({
    queryKey: [...freelancerKeys.detail(freelancer_id), "monthly", month],
    queryFn: async () => {
      return apiGet<FreelancerMonthlyBreakdown>("/freelancers/{freelancer_id}/monthly", { path: { freelancer_id }, query: { month } });
    },
    enabled: freelancer_id > 0 && /^\d{4}-\d{2}$/.test(month),
  });
}

export function useFreelancerMonthlySeries(
  freelancer_id: number,
  months_back: number = 6,
  months_forward: number = 3,
) {
  return useQuery<FreelancerMonthlySeries>({
    queryKey: [
      ...freelancerKeys.detail(freelancer_id),
      "monthly-series",
      months_back,
      months_forward,
    ],
    queryFn: async () => {
      return apiGet<FreelancerMonthlySeries>("/freelancers/{freelancer_id}/monthly-series", {
            path: { freelancer_id },
            query: { months_back, months_forward },
          });
    },
    enabled: freelancer_id > 0,
  });
}

export function useDeleteFreelancer() {
  const qc = useQueryClient();
  return useMutation<void, Error, { freelancer_id: number; force?: boolean }>({
    mutationFn: async ({ freelancer_id, force = false }) => {
      const r = await deleteFreelancerAction(freelancer_id, force);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: freelancerKeys.all });
    },
  });
}
