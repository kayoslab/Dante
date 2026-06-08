"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AssignmentCreate, AssignmentDetail, AssignmentUpdate, EstimateRequest, EstimateResponse } from "./types";
import { projectKeys } from "./projects";
import { APIError } from "./types";
import {
  createAssignmentAction,
  deleteAssignmentAction,
  endAssignmentAction,
  estimateAssignmentAction,
  updateAssignmentAction,
} from "@/lib/actions/assignment";

export type { AssignmentDetail };
export type { AssignmentCreate };
export type { EstimateRequest };
export type { EstimateResponse };

export function useEstimate(req: EstimateRequest | null) {
  return useQuery<EstimateResponse>({
    queryKey: ["assignment-estimate", req],
    enabled: req !== null,
    staleTime: 0,
    queryFn: async () => {
      const r = await estimateAssignmentAction(req!);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      // EstimateResponse; cast is safe because every field is present.
      return r.data as unknown as EstimateResponse;
    },
  });
}

export type { AssignmentUpdate };

export function useUpdateAssignment(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      assignment_id,
      body,
    }: {
      assignment_id: number;
      body: AssignmentUpdate;
    }) => {
      const r = await updateAssignmentAction(assignment_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useCreateAssignment(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AssignmentCreate) => {
      const r = await createAssignmentAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useDeleteAssignment(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (assignment_id: number) => {
      const r = await deleteAssignmentAction(assignment_id);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

export function useEndAssignment(project_id: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      assignment_id,
      end_date,
    }: {
      assignment_id: number;
      end_date: string;
    }) => {
      const r = await endAssignmentAction(assignment_id, { end_date });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectKeys.detail(project_id) });
    },
  });
}

