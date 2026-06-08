"use client";

import { apiGet } from "./_fetch";

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { APIError } from "./types";
import type { CustomerCreate, CustomerDetail, CustomerListItem, CustomerUpdate } from "./types";
import {
  createCustomerAction,
  deleteCustomerAction,
  updateCustomerAction,
} from "@/lib/actions/customer";

export type Customer = CustomerListItem;
export type { CustomerDetail };
export type { CustomerCreate };
export type { CustomerUpdate };

type Sort = "name" | "n_projects" | "n_frameworks" | "customer_id";
type Order = "asc" | "desc";

import { customerKeys } from "./keys";
export { customerKeys };

export function useCustomers(
  sort: Sort = "name",
  order: Order = "asc",
  options?: Omit<UseQueryOptions<Customer[]>, "queryKey" | "queryFn">,
) {
  return useQuery<Customer[]>({
    queryKey: customerKeys.list(sort, order),
    queryFn: async () => {
      return apiGet<Customer[]>("/customers", { query: { sort, order } });
    },
    ...options,
  });
}

export function useCustomer(customerId: number) {
  return useQuery<CustomerDetail>({
    queryKey: customerKeys.detail(customerId),
    queryFn: async () => {
      return apiGet<CustomerDetail>("/customers/{customer_id}", { path: { customer_id: customerId } });
    },
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CustomerCreate) => {
      const r = await createCustomerAction(body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}

export function useUpdateCustomer(customerId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CustomerUpdate) => {
      const r = await updateCustomerAction(customerId, body);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.all });
      qc.invalidateQueries({ queryKey: customerKeys.detail(customerId) });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation<void, Error, { customerId: number; force?: boolean }>({
    mutationFn: async ({ customerId, force = false }) => {
      const r = await deleteCustomerAction(customerId, force);
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: customerKeys.all });
    },
  });
}

