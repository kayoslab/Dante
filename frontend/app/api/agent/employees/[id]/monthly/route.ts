/** Per-employee monthly economics — revenue, cost, margin, utilization. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle, NotFound } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { computeEmployeeMonthly } from "@/lib/db/queries/employee-monthly";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/),
});

const QuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .openapi({ example: "2026-06" }),
});

const EmployeeMonthlyAssignmentSchema = z
  .object({
    assignment_id: z.number().int(),
    project_id: z.number().int(),
    project_name: z.string(),
    customer_name: z.string(),
    profile: z.string().nullable(),
    allocation_pct: z.string(),
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
    billing_model: z.enum(["fixed_price", "time_and_material"]),
    tracked_hours: z.string().openapi({
      description:
        "Hours logged on this specific project in this month. Use to " +
        "answer 'which projects did this employee work on in month X?'.",
    }),
    revenue: z.string(),
    allocation_revenue: z.string(),
  })
  .openapi("AgentEmployeeMonthlyAssignment");

const EmployeeMonthlySchema = z
  .object({
    employee_id: z.number().int(),
    who_name: z.string(),
    month: z.string(),
    monthly_cost_full: z.string().nullable().openapi({
      description: "Loaded payroll cost for the month (incl. burden).",
    }),
    revenue: z.string().openapi({
      description:
        "Billable revenue — T&M tracked × rate plus the employee's " +
        "share of FP recognition.",
    }),
    allocation_revenue: z.string().openapi({
      description:
        "Forward-looking sibling: T&M allocation × rate plus FP share.",
    }),
    margin: z.string(),
    margin_pct: z.string().nullable(),
    utilization_pct: z.string(),
    tracked_utilization_pct: z.string().nullable(),
    fte: z.string(),
    under_contract: z.boolean(),
    assignments: z.array(EmployeeMonthlyAssignmentSchema).openapi({
      description:
        "Per-project breakdown for every allocation this employee held " +
        "during the month. Each row carries tracked hours on THAT " +
        "specific project — answer 'which project did this person work " +
        "on in month X?' without a follow-up call.",
    }),
  })
  .openapi("AgentEmployeeMonthly");

export const getEmployeeMonthlyOp = defineAgentOp({
  method: "get",
  path: "/employees/{id}/monthly",
  operationId: "getEmployeeMonthly",
  summary: "Per-employee monthly P&L + utilization.",
  description:
    "Loaded cost, billable revenue (T&M tracked × rate plus FP share), " +
    "margin, allocation-based utilization, and tracked utilization for " +
    "one employee × month. Requires `read:salaries` because the cost " +
    "figure is salary-derived.",
  scope: "read:salaries",
  pathParams: PathParamsSchema,
  queryParams: QuerySchema,
  response: EmployeeMonthlySchema,
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: getEmployeeMonthlyOp.scope,
    });
    const pathParsed = getEmployeeMonthlyOp.parsePath!(await params);
    const queryParsed = getEmployeeMonthlyOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const employee_id = Number.parseInt(pathParsed.id, 10);

    const breakdown = await computeEmployeeMonthly(
      employee_id,
      queryParsed.month,
    );
    if (!breakdown) {
      throw NotFound(`employee not found: ${employee_id}`);
    }

    const body = getEmployeeMonthlyOp.response.parse({
      employee_id: breakdown.entity_id,
      who_name: String(breakdown.who_name ?? ""),
      month: breakdown.month,
      monthly_cost_full: (breakdown.monthly_cost_full as string | null) ?? null,
      revenue: breakdown.revenue as string,
      allocation_revenue: breakdown.allocation_revenue as string,
      margin: breakdown.margin as string,
      margin_pct: (breakdown.margin_pct as string | null) ?? null,
      utilization_pct: breakdown.utilization_pct as string,
      tracked_utilization_pct:
        (breakdown.tracked_utilization_pct as string | null) ?? null,
      fte: breakdown.fte as string,
      under_contract: Boolean(breakdown.under_contract),
      assignments: (breakdown.assignments as Array<Record<string, unknown>>).map(
        (a) => ({
          assignment_id: a.assignment_id as number,
          project_id: a.project_id as number,
          project_name: a.project_name as string,
          customer_name: a.customer_name as string,
          profile: (a.profile as string | null) ?? null,
          allocation_pct: a.allocation_pct as string,
          start_date: (a.assignment_start_date as string | null) ?? null,
          end_date: (a.assignment_end_date as string | null) ?? null,
          billing_model: a.billing_model as "fixed_price" | "time_and_material",
          tracked_hours: (a.tracked_hours as string | null) ?? "0.00",
          revenue: a.revenue as string,
          allocation_revenue: a.allocation_revenue as string,
        }),
      ),
    });

    await audit(ctx, {
      action: "agent_get_employee_monthly",
      target_type: "employee",
      target_id: employee_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: getEmployeeMonthlyOp.path,
      employee_id,
      month: queryParsed.month,
    });

    return body;
  });
}
