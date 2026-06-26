/** Barrel that side-effect-imports every `/api/agent/*` route file so
 * the OpenAPI registry is populated regardless of which route Next.js
 * happens to load first. Imported by
 * `app/api/agent/openapi.json/route.ts` before it emits the spec.
 *
 * Each route file `export const`s its `defineAgentOp` result, and the
 * `defineAgentOp` factory registers the operation on the shared
 * registry as a side effect of import. Listing every route here is
 * the price for not having a build step that walks the route tree —
 * adding a new endpoint means one more line in this file.
 *
 * Type re-exports are present so other modules (the route handlers
 * themselves) can `import { listProjectsOp } from "@/lib/agent/operations"`
 * if that's tidier than reaching into the route file. */
export { listProjectsOp } from "@/app/api/agent/projects/route";
export { getProjectMonthlyOp } from "@/app/api/agent/projects/[id]/monthly/route";
export { listCustomersOp } from "@/app/api/agent/customers/route";
export { getPortfolioRentabilityOp } from "@/app/api/agent/reports/portfolio-rentability/route";
export { getCustomerRentabilityOp } from "@/app/api/agent/reports/customer-rentability/route";
export { getFpBurndownOp } from "@/app/api/agent/reports/fp-burndown/route";
export { listEmployeesOp } from "@/app/api/agent/employees/route";
export { getEmployeeMonthlyOp } from "@/app/api/agent/employees/[id]/monthly/route";
