"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { TeamCreate, TeamDeleteResult, TeamItem, TeamRename } from "./types";
import { APIError } from "./types";
import {
  createTeamAction,
  deleteTeamAction,
  renameTeamAction,
} from "@/lib/actions/team";

export type { TeamItem };
export type { TeamCreate };
export type { TeamRename };

export const teamKeys = {
  all: ["teams"] as const,
  list: () => [...teamKeys.all, "list"] as const,
};

export function useTeams() {
  return useQuery<TeamItem[]>({
    queryKey: teamKeys.list(),
    queryFn: async () => {
      return apiGet<TeamItem[]>("/teams");
    },
  });
}

export function useCreateTeam() {
  const qc = useQueryClient();
  return useMutation<TeamItem, Error, TeamCreate>({
    mutationFn: async (body) => {
      const r = await createTeamAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
    },
  });
}

export function useRenameTeam() {
  const qc = useQueryClient();
  return useMutation<
    TeamItem,
    Error,
    { team_name: string; new_name: string }
  >({
    mutationFn: async ({ team_name, new_name }) => {
      const r = await renameTeamAction(team_name, { new_name });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
      // Member team_user values may have changed.
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}

export function useDeleteTeam() {
  const qc = useQueryClient();
  return useMutation<
    TeamDeleteResult,
    Error,
    { team_name: string; force?: boolean }
  >({
    mutationFn: async ({ team_name, force = false }) => {
      const r = await deleteTeamAction(team_name, force);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: teamKeys.all });
      qc.invalidateQueries({ queryKey: ["employees"] });
    },
  });
}
