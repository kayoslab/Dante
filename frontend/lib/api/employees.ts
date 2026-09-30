"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "./_fetch";
import type { EmployeeAllocation, EmployeeDetail, EmployeeFlagsUpdate, EmployeeListItem, EmployeeMonthlyAssignmentRow, EmployeeMonthlyBreakdown, EmployeeMonthlySeries, EmployeeMonthlySeriesPoint, EmployeeSalaryChange, EmployeeSalaryPoint } from "./types";
import { APIError } from "./types";
import { updateEmployeeFlagsAction } from "@/lib/actions/employee";

export type { EmployeeListItem };
export type { EmployeeDetail };
export type { EmployeeAllocation };
export type { EmployeeSalaryChange };
export type { EmployeeFlagsUpdate };
export type { EmployeeMonthlyBreakdown };
export type { EmployeeMonthlyAssignmentRow };
export type { EmployeeMonthlySeries };
export type { EmployeeMonthlySeriesPoint };
export type { EmployeeSalaryPoint };

import { employeeKeys } from "./keys";
export { employeeKeys };

export function useEmployees(filters: {
  q?: string;
  status?: string;
  team?: string;
  include_excluded?: boolean;
} = {}) {
  return useQuery<EmployeeListItem[]>({
    queryKey: employeeKeys.list(filters),
    queryFn: async () => {
      return apiGet<EmployeeListItem[]>("/employees", { query: filters });
    },
  });
}

// Prefetched server-side in app/reports/time/page.tsx under
// employeeKeys.teams() — keep in sync.
export function useEmployeeTeams() {
  return useQuery<string[]>({
    queryKey: employeeKeys.teams(),
    queryFn: async () => {
      return apiGet<string[]>("/employees/teams");
    },
    staleTime: 5 * 60_000,
  });
}

export function useEmployee(employee_id: number) {
  return useQuery<EmployeeDetail>({
    queryKey: employeeKeys.detail(employee_id),
    queryFn: async () => {
      return apiGet<EmployeeDetail>("/employees/{employee_id}", { path: { employee_id } });
    },
    enabled: employee_id > 0,
  });
}

export function useEmployeeAllocations(employee_id: number) {
  return useQuery<EmployeeAllocation[]>({
    queryKey: employeeKeys.allocations(employee_id),
    queryFn: async () => {
      return apiGet<EmployeeAllocation[]>("/employees/{employee_id}/allocations", { path: { employee_id } });
    },
    enabled: employee_id > 0,
  });
}

export function useEmployeeSalaryTrajectory(employee_id: number) {
  return useQuery<EmployeeSalaryPoint[]>({
    queryKey: [...employeeKeys.detail(employee_id), "salary-trajectory"],
    queryFn: async () => {
      return apiGet<EmployeeSalaryPoint[]>("/employees/{employee_id}/salary-trajectory", { path: { employee_id } });
    },
    enabled: employee_id > 0,
  });
}

export function useEmployeeSalaryHistory(employee_id: number) {
  return useQuery<EmployeeSalaryChange[]>({
    queryKey: employeeKeys.salaryHistory(employee_id),
    queryFn: async () => {
      return apiGet<EmployeeSalaryChange[]>("/employees/{employee_id}/salary-history", { path: { employee_id } });
    },
    enabled: employee_id > 0,
  });
}

export function useEmployeeMonthly(employee_id: number, month: string) {
  return useQuery<EmployeeMonthlyBreakdown>({
    queryKey: [...employeeKeys.detail(employee_id), "monthly", month],
    queryFn: async () => {
      return apiGet<EmployeeMonthlyBreakdown>("/employees/{employee_id}/monthly", { path: { employee_id }, query: { month } });
    },
    enabled: employee_id > 0 && /^\d{4}-\d{2}$/.test(month),
  });
}

export function useEmployeeMonthlySeries(
  employee_id: number,
  months_back: number = 6,
  months_forward: number = 3,
) {
  return useQuery<EmployeeMonthlySeries>({
    queryKey: [
      ...employeeKeys.detail(employee_id),
      "monthly-series",
      months_back,
      months_forward,
    ],
    queryFn: async () => {
      return apiGet<EmployeeMonthlySeries>("/employees/{employee_id}/monthly-series", {
            path: { employee_id },
            query: { months_back, months_forward },
          });
    },
    enabled: employee_id > 0,
  });
}

export function useUpdateEmployeeFlags(employee_id: number) {
  const qc = useQueryClient();
  return useMutation<EmployeeDetail, Error, EmployeeFlagsUpdate>({
    mutationFn: async (body) => {
      const r = await updateEmployeeFlagsAction(employee_id, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      // (all declared fields present); cast is sound during migration.
      return r.data as unknown as EmployeeDetail;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: employeeKeys.detail(employee_id) });
      qc.invalidateQueries({ queryKey: employeeKeys.all });
    },
  });
}
