"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { EmployeeInspectPayload } from "./types";

export type { EmployeeInspectPayload };

export function useEmployeeInspect(employee_id: number, enabled: boolean) {
  return useQuery<EmployeeInspectPayload>({
    queryKey: ["inspect", employee_id],
    queryFn: async () => {
      return apiGet<EmployeeInspectPayload>("/inspect/{employee_id}", { path: { employee_id } });
    },
    enabled: enabled && employee_id > 0,
    staleTime: 60_000,
  });
}
