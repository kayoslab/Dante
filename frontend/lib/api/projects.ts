"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { MonthlyAssignmentRow, MonthlyBreakdown, ProjectAssignment, ProjectCreate, ProjectDetail, ProjectEconomics, ProjectListItem, ProjectUpdate, RateCreate } from "./types";
import { customerKeys } from "./customers";
import { APIError } from "./types";
import {
  addProjectRateAction,
  createProjectAction,
  deleteProjectAction,
  deleteProjectRateAction,
  updateProjectAction,
  updateProjectRateAction,
} from "@/lib/actions/project";

export type { ProjectDetail };
export type { ProjectCreate };
export type { ProjectEconomics };
export type { ProjectAssignment };
export type { ProjectListItem };
export type { MonthlyBreakdown };
export type { MonthlyAssignmentRow };
export type { RateCreate };

import { projectKeys } from "./keys";
export { projectKeys };

export function useProjects(status?: string) {
  return useQuery<ProjectListItem[]>({
    queryKey: ["projects-list", { status }],
    queryFn: async () => {
      return apiGet<ProjectListItem[]>("/projects", { query: status ? { status } : {} });
    },
  });
}

export function useProjectMonthly(project_id: number, month: string) {
  return useQuery<MonthlyBreakdown>({
    queryKey: [...projectKeys.detail(project_id), "monthly", month],
    queryFn: async () => {
      return apiGet<MonthlyBreakdown>("/projects/{project_id}/monthly", { path: { project_id }, query: { month } });
    },
    enabled: project_id > 0 && /^\d{4}-\d{2}$/.test(month),
  });
}

export function useProject(project_id: number) {
  return useQuery<ProjectDetail>({
    queryKey: projectKeys.detail(project_id),
    queryFn: async () => {
      return apiGet<ProjectDetail>("/projects/{project_id}", { path: { project_id } });
    },
  });
}

export type { ProjectUpdate };

export function useUpdateProject(project_id: number, customer_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: ProjectUpdate) => {
      const r = await updateProjectAction(project_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useUpdateProjectRate(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profile,
      valid_from,
      daily_rate_eur,
    }: {
      profile: string;
      valid_from: string;
      daily_rate_eur: number;
    }) => {
      const r = await updateProjectRateAction(
        project_id,
        profile,
        valid_from,
        { daily_rate_eur },
      );
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useCreateProject(customer_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Omit<ProjectCreate, "customer_id">) => {
      const r = await createProjectAction({ customer_id, ...body });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useDeleteProject(project_id: number, customer_id: number) {
  const qc = useQueryClient();
  return useMutation<void, Error, boolean | undefined>({
    mutationFn: async (force) => {
      const r = await deleteProjectAction(project_id, force ?? false);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useAddProjectRate(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RateCreate) => {
      const r = await addProjectRateAction(project_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useDeleteProjectRate(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profile,
      valid_from,
    }: {
      profile: string;
      valid_from: string;
    }) => {
      const r = await deleteProjectRateAction(
        project_id,
        profile,
        valid_from,
      );
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}
