"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import { projectKeys } from "./projects";
import { employeeKeys } from "./employees";
import type { AworkCompanyItem, AworkImportableProject, AworkProjectItem, AworkUserItem } from "./types";
import { APIError } from "./types";
import {
  createAworkProjectLinkAction,
  createAworkUserLinkAction,
  deleteAworkProjectLinkAction,
  deleteAworkUserLinkAction,
} from "@/lib/actions/link";
import {
  importCustomerFromAworkAction,
  importProjectFromAworkAction,
} from "@/lib/actions/awork-import";

export type { AworkProjectItem };
export type { AworkUserItem };
export type { AworkCompanyItem };
export type { AworkImportableProject };

export const aworkKeys = {
  all: ["awork"] as const,
  projects: (filters: { mapped?: boolean; q?: string }) =>
    [...aworkKeys.all, "projects", filters] as const,
  projectLinksFor: (project_id: number) =>
    [...aworkKeys.all, "project-links", project_id] as const,
  users: (filters: { linked?: boolean; include_archived?: boolean }) =>
    [...aworkKeys.all, "users", filters] as const,
  userLinksFor: (employee_id: number) =>
    [...aworkKeys.all, "user-links", employee_id] as const,
  companies: (filters: { mapped?: boolean; q?: string }) =>
    [...aworkKeys.all, "companies", filters] as const,
  companyLinkFor: (customer_id: number) =>
    [...aworkKeys.all, "company-link", customer_id] as const,
  importableProjects: (customer_id: number | null) =>
    [...aworkKeys.all, "importable-projects", customer_id] as const,
};

// --- awork projects -------------------------------------------------------

export function useAworkProjects(filters: {
  mapped?: boolean;
  q?: string;
} = {}) {
  return useQuery<AworkProjectItem[]>({
    queryKey: aworkKeys.projects(filters),
    queryFn: async () => {
      return apiGet<AworkProjectItem[]>("/awork-projects", { query: filters });
    },
    staleTime: 60_000,
  });
}

export function useAworkProjectLinksFor(project_id: number) {
  return useQuery<AworkProjectItem[]>({
    queryKey: aworkKeys.projectLinksFor(project_id),
    queryFn: async () => {
      return apiGet<AworkProjectItem[]>("/projects/{project_id}/awork-links", { path: { project_id } });
    },
    enabled: project_id > 0,
  });
}

export function useCreateAworkProjectLink(project_id: number) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (awork_project_id) => {
      const r = await createAworkProjectLinkAction(project_id, {
        awork_project_id,
      });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useDeleteAworkProjectLink(project_id: number) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (awork_project_id) => {
      const r = await deleteAworkProjectLinkAction(project_id, awork_project_id);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

// --- awork users ----------------------------------------------------------

export function useAworkUsers(filters: {
  linked?: boolean;
  include_archived?: boolean;
} = {}) {
  return useQuery<AworkUserItem[]>({
    queryKey: aworkKeys.users(filters),
    queryFn: async () => {
      return apiGet<AworkUserItem[]>("/awork-users", { query: filters });
    },
  });
}

export function useAworkUserLinksFor(employee_id: number) {
  return useQuery<AworkUserItem[]>({
    queryKey: aworkKeys.userLinksFor(employee_id),
    queryFn: async () => {
      return apiGet<AworkUserItem[]>("/employees/{employee_id}/awork-links", { path: { employee_id } });
    },
    enabled: employee_id > 0,
  });
}

export function useCreateAworkUserLink(employee_id: number) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (awork_user_id) => {
      const r = await createAworkUserLinkAction(employee_id, {
        awork_user_id,
      });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: employeeKeys.detail(employee_id) });
    },
  });
}

export function useDeleteAworkUserLink(employee_id: number) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (awork_user_id) => {
      const r = await deleteAworkUserLinkAction(employee_id, awork_user_id);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: employeeKeys.detail(employee_id) });
    },
  });
}

// --- Phase B.4: awork companies + import flows ---------------------------

export function useAworkCompanies(filters: {
  mapped?: boolean;
  q?: string;
} = {}) {
  return useQuery<AworkCompanyItem[]>({
    queryKey: aworkKeys.companies(filters),
    queryFn: async () => {
      return apiGet<AworkCompanyItem[]>("/awork-companies", { query: filters });
    },
    staleTime: 60_000,
  });
}

export function useImportCustomerFromAwork() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    { awork_company_id: string; name_override?: string | null }
  >({
    mutationFn: async (body) => {
      const r = await importCustomerFromAworkAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useImportableAworkProjects(customer_id: number | null) {
  return useQuery<AworkImportableProject[]>({
    queryKey: aworkKeys.importableProjects(customer_id),
    queryFn: async () => {
      return apiGet<AworkImportableProject[]>("/awork-projects-importable", { query: customer_id ? { customer_id } : {} });
    },
    staleTime: 30_000,
  });
}

export function useImportProjectFromAwork() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    {
      awork_project_id: string;
      customer_id_override?: number | null;
      framework_id_override?: number | null;
      billing_model_override?: string | null;
      name_override?: string | null;
      agreed_amount_eur?: number | null;
    }
  >({
    mutationFn: async (body) => {
      const r = await importProjectFromAworkAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aworkKeys.all });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
