"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { FrameworkCreate, FrameworkDetail, FrameworkUpdate, Rate, RateCreate } from "./types";
import { customerKeys } from "./customers";
import { APIError } from "./types";
import {
  addFrameworkRateAction,
  createFrameworkAction,
  deleteFrameworkAction,
  deleteFrameworkRateAction,
  updateFrameworkAction,
  updateFrameworkRateAction,
} from "@/lib/actions/framework";

export type { FrameworkDetail };
export type { FrameworkCreate };
export type { Rate };
export type { RateCreate };

import { frameworkKeys } from "./keys";
export { frameworkKeys };

export function useFramework(framework_id: number) {
  return useQuery<FrameworkDetail>({
    queryKey: frameworkKeys.detail(framework_id),
    queryFn: async () => {
      return apiGet<FrameworkDetail>("/frameworks/{framework_id}", { path: { framework_id } });
    },
  });
}

export type { FrameworkUpdate };

export function useUpdateFramework(framework_id: number, customer_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: FrameworkUpdate) => {
      const r = await updateFrameworkAction(framework_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: frameworkKeys.detail(framework_id) });
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useUpdateFrameworkRate(framework_id: number) {
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
      const r = await updateFrameworkRateAction(
        framework_id,
        profile,
        valid_from,
        { daily_rate_eur },
      );
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: frameworkKeys.detail(framework_id) });
    },
  });
}

export function useCreateFramework(customer_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Omit<FrameworkCreate, "customer_id">) => {
      const r = await createFrameworkAction({ customer_id, ...body });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useDeleteFramework(framework_id: number, customer_id: number) {
  const qc = useQueryClient();
  return useMutation<void, Error, boolean | undefined>({
    mutationFn: async (force) => {
      const r = await deleteFrameworkAction(framework_id, force ?? false);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: frameworkKeys.detail(framework_id) });
      qc.invalidateQueries({ queryKey: customerKeys.detail(customer_id) });
    },
  });
}

export function useAddFrameworkRate(framework_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: RateCreate) => {
      const r = await addFrameworkRateAction(framework_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: frameworkKeys.detail(framework_id) });
    },
  });
}

export function useDeleteFrameworkRate(framework_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      profile,
      valid_from,
    }: {
      profile: string;
      valid_from: string;
    }) => {
      const r = await deleteFrameworkRateAction(
        framework_id,
        profile,
        valid_from,
      );
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: frameworkKeys.detail(framework_id) });
    },
  });
}
