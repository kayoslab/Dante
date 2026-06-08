/** TanStack Query keys for every entity.
 *
 * Plain JS — *no* `"use client"`. Server Components must import keys from
 * here when prefetching, because importing a function from a `"use client"`
 * module gives back a client reference that is not callable on the server.
 *
 * Client hook files re-export from here so existing client-side imports
 * (`customerKeys` from `lib/api/customers`) keep working.
 */

type CustomerSort = "name" | "n_projects" | "n_frameworks" | "customer_id";
type Order = "asc" | "desc";

export const customerKeys = {
  all: ["customers"] as const,
  list: (sort: CustomerSort, order: Order) =>
    [...customerKeys.all, { sort, order }] as const,
  detail: (id: number) => [...customerKeys.all, id] as const,
};

export const freelancerKeys = {
  all: ["freelancers"] as const,
  list: (status?: string) => [...freelancerKeys.all, { status }] as const,
  detail: (id: number) => [...freelancerKeys.all, id] as const,
};

export const frameworkKeys = {
  all: ["frameworks"] as const,
  detail: (id: number) => [...frameworkKeys.all, id] as const,
};

export const projectKeys = {
  all: ["projects"] as const,
  detail: (id: number) => [...projectKeys.all, id] as const,
};

export const employeeKeys = {
  all: ["employees"] as const,
  list: (filters: {
    q?: string;
    status?: string;
    team?: string;
    include_excluded?: boolean;
  }) => [...employeeKeys.all, "list", filters] as const,
  detail: (id: number) => [...employeeKeys.all, id] as const,
  allocations: (id: number) =>
    [...employeeKeys.all, id, "allocations"] as const,
  salaryHistory: (id: number) => [...employeeKeys.all, id, "salary"] as const,
  teams: () => [...employeeKeys.all, "teams"] as const,
};
