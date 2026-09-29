"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createExternalLinkAction,
  deleteExternalLinkAction,
  importCustomerFromSourceAction,
  importProjectFromSourceAction,
  type LinkInput,
} from "@/lib/actions/external-links";

import { apiGet } from "./_fetch";
import { customerKeys } from "./customers";
import { employeeKeys } from "./employees";
import { projectKeys } from "./projects";
import {
  APIError,
  type ExternalRecordItem,
  type ImportableProjectItem,
  type IntegrationsResponse,
  type LinkItem,
} from "./types";

export type { ExternalRecordItem, ImportableProjectItem, IntegrationsResponse, LinkItem };

export const integrationKeys = {
  all: ["integrations"] as const,
  list: () => [...integrationKeys.all, "list"] as const,
  records: (slug: string, filters: RecordFilters) => [...integrationKeys.all, "records", slug, filters] as const,
  importable: (slug: string, customer_id: number | null) =>
    [...integrationKeys.all, "importable", slug, customer_id] as const,
  linksFor: (dante_type: string, dante_id: number) => [...integrationKeys.all, "links", dante_type, dante_id] as const,
};

export type RecordFilters = {
  type: "person" | "project" | "company";
  mapped?: boolean;
  q?: string;
  include_archived?: boolean;
};

/** Enabled integrations + which one (if any) imports customers/projects. */
export function useIntegrations() {
  return useQuery<IntegrationsResponse>({
    queryKey: integrationKeys.list(),
    queryFn: () => apiGet<IntegrationsResponse>("/integrations"),
    staleTime: 60_000,
  });
}

export function useExternalRecords(slug: string, filters: RecordFilters, enabled = true) {
  return useQuery<ExternalRecordItem[]>({
    queryKey: integrationKeys.records(slug, filters),
    queryFn: () =>
      apiGet<ExternalRecordItem[]>("/integrations/{slug}/records", { path: { slug }, query: filters }),
    staleTime: 60_000,
    enabled: enabled && slug.length > 0,
  });
}

export function useImportableProjects(slug: string | null, customer_id: number | null) {
  return useQuery<ImportableProjectItem[]>({
    queryKey: integrationKeys.importable(slug ?? "", customer_id),
    queryFn: () =>
      apiGet<ImportableProjectItem[]>("/integrations/{slug}/records", {
        path: { slug: slug ?? "" },
        query: { type: "project", importable_for_customer: customer_id ?? 0 },
      }),
    enabled: slug !== null,
  });
}

export function useLinksFor(dante_type: LinkInput["dante_type"], dante_id: number) {
  return useQuery<LinkItem[]>({
    queryKey: integrationKeys.linksFor(dante_type, dante_id),
    queryFn: () => apiGet<LinkItem[]>("/links", { query: { dante_type, dante_id } }),
    enabled: dante_id > 0,
  });
}

function invalidateFor(qc: ReturnType<typeof useQueryClient>, link: LinkInput) {
  qc.invalidateQueries({ queryKey: integrationKeys.all });
  if (link.dante_type === "project") qc.invalidateQueries({ queryKey: projectKeys.detail(link.dante_id) });
  if (link.dante_type === "employee") qc.invalidateQueries({ queryKey: employeeKeys.all });
  if (link.dante_type === "customer") qc.invalidateQueries({ queryKey: customerKeys.all });
}

export function useCreateLink() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, LinkInput>({
    mutationFn: async (link) => {
      const r = await createExternalLinkAction(link);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: (_d, link) => invalidateFor(qc, link),
  });
}

export function useDeleteLink() {
  const qc = useQueryClient();
  return useMutation<void, Error, LinkInput>({
    mutationFn: async (link) => {
      const r = await deleteExternalLinkAction(link);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: (_d, link) => invalidateFor(qc, link),
  });
}

export function useImportCustomer() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { integration_slug: string; external_id: string; name_override?: string | null }>({
    mutationFn: async (input) => {
      const r = await importCustomerFromSourceAction(input);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: integrationKeys.all });
      qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}

export function useImportProject() {
  const qc = useQueryClient();
  return useMutation<
    unknown,
    Error,
    {
      integration_slug: string;
      external_id: string;
      customer_id_override?: number | null;
      framework_id_override?: number | null;
      billing_model_override?: string | null;
      name_override?: string | null;
      agreed_amount_eur?: number | null;
    }
  >({
    mutationFn: async (input) => {
      const r = await importProjectFromSourceAction(input);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: integrationKeys.all });
      qc.invalidateQueries({ queryKey: projectKeys.all });
      qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}
