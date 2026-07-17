"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import { projectKeys } from "./projects";
import type { PersonioProjectItem } from "./types";
import { APIError } from "./types";
import {
  createPersonioLinkAction,
  deletePersonioLinkAction,
} from "@/lib/actions/link";

export type { PersonioProjectItem };

type PersonioProjectFilters = {
  mapped?: boolean;
  q?: string;
  show_archived?: boolean;
};

export const personioProjectKeys = {
  all: ["personio-projects"] as const,
  list: (filters: PersonioProjectFilters) =>
    [...personioProjectKeys.all, filters] as const,
  linksFor: (project_id: number) =>
    [...personioProjectKeys.all, "links", project_id] as const,
};

export function usePersonioProjects(filters: PersonioProjectFilters = {}) {
  return useQuery<PersonioProjectItem[]>({
    queryKey: personioProjectKeys.list(filters),
    queryFn: async () => {
      return apiGet<PersonioProjectItem[]>("/personio-projects", { query: filters });
    },
    staleTime: 60_000,
  });
}

export function usePersonioLinksFor(project_id: number) {
  return useQuery<PersonioProjectItem[]>({
    queryKey: personioProjectKeys.linksFor(project_id),
    queryFn: async () => {
      return apiGet<PersonioProjectItem[]>("/projects/{project_id}/personio-links", { path: { project_id } });
    },
    enabled: project_id > 0,
  });
}

export function useCreatePersonioLink(project_id: number) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: async (personio_project_id) => {
      const r = await createPersonioLinkAction(project_id, { personio_project_id });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personioProjectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useDeletePersonioLink(project_id: number) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (personio_project_id) => {
      const r = await deletePersonioLinkAction(project_id, personio_project_id);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: personioProjectKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

