/** Per-project monthly P&L — slim shape. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle, NotFound } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { computeProjectMonthly } from "@/lib/db/queries/project-monthly";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "42" }),
});

const QueryParamsSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .openapi({ example: "2026-06" }),
});

const ProjectMonthlyAssignmentSchema = z
  .object({
    assignment_id: z.number().int(),
    kind: z.enum(["employee", "freelancer"]),
    employee_id: z.number().int().nullable(),
    freelancer_id: z.number().int().nullable(),
    who_name: z.string().nullable(),
    profile: z.string().nullable(),
    allocation_pct: z.string(),
    start_date: z.string().nullable(),
    end_date: z.string().nullable(),
    tracked_hours: z.string().nullable().openapi({
      description:
        "Hours this entity logged on THIS project in THIS month. Null " +
        "for freelancers (no awork tracking — they bill via " +
        "freelancer-hours instead). Use to answer 'who actually worked " +
        "on this project in month X?'.",
    }),
    revenue: z.string().nullable(),
    cost: z.string(),
    margin: z.string().nullable(),
  })
  .openapi("AgentProjectMonthlyAssignment");

const ProjectMonthlySchema = z
  .object({
    project_id: z.number().int(),
    project_name: z.string(),
    billing_model: z.enum(["fixed_price", "time_and_material"]),
    month: z.string(),
    working_days_in_month: z.number().int(),
    agreed_amount_eur: z.string().nullable(),
    revenue: z.string().nullable().openapi({
      description:
        "T&M billable revenue (tracked hours × rate). Null for FP " +
        "projects — use cumulative_recognized_revenue instead.",
    }),
    cost: z.string(),
    margin: z.string().nullable(),
    margin_pct: z.string().nullable(),
    burdened_cost: z.string(),
    burdened_margin: z.string().nullable(),
    cumulative_recognized_revenue: z.string().nullable().openapi({
      description: "FP-only.",
    }),
    cumulative_margin: z.string().nullable(),
    tracked_hours: z.string().openapi({
      description:
        "Employee attendance hours (Personio/awork) for the month. Does " +
        "NOT include freelancer hours — see `freelancer_hours`.",
    }),
    freelancer_hours: z.string().openapi({
      description:
        "Freelancer hours entered for the month (from freelancer bills / " +
        "time sheets, `freelancer_time_entry`). Separate from " +
        "`tracked_hours`, which is employee attendance only — add both " +
        "for total effort on a mixed project.",
    }),
    has_personio_mapping: z.boolean(),
    // Lifetime (project-to-date) aggregates — for both billing models.
    cumulative_revenue: z.string().nullable().openapi({
      description:
        "Lifetime billable revenue: FP recognized revenue, T&M tracked " +
        "hours × rate across all months.",
    }),
    cumulative_cost: z.string().nullable().openapi({
      description: "Lifetime allocated (unburdened) cost across all months.",
    }),
    cumulative_burdened_cost: z.string().nullable().openapi({
      description: "Lifetime burdened cost across all months.",
    }),
    cumulative_burdened_margin: z.string().nullable().openapi({
      description: "cumulative_revenue − cumulative_burdened_cost.",
    }),
    lifetime_tracked_person_days: z.string().nullable().openapi({
      description: "Lifetime tracked hours / 8 (person-days).",
    }),
    tracked_hours_lifetime: z.string().nullable().openapi({
      description: "Lifetime tracked hours across all months.",
    }),
    assignments: z.array(ProjectMonthlyAssignmentSchema).openapi({
      description:
        "Per-assignment breakdown for every allocation active during " +
        "this month. Includes tracked hours per (employee, project) — " +
        "answer 'which consultants worked on this project before " +
        "<date>?' by walking the months backwards.",
    }),
  })
  .openapi("AgentProjectMonthly");

export const getProjectMonthlyOp = defineAgentOp({
  method: "get",
  path: "/projects/{id}/monthly",
  operationId: "getProjectMonthly",
  summary: "Per-project monthly P&L.",
  description:
    "Returns the slim monthly P&L for one project + month: revenue " +
    "(tracked-billable for T&M, recognized for FP), allocated and " +
    "burdened cost, margin in both bases, tracked hours. Use to " +
    "answer 'how is project X doing in month Y?' after `listProjects` " +
    "surfaces the IDs.",
  scope: "read:projects",
  pathParams: PathParamsSchema,
  queryParams: QueryParamsSchema,
  response: ProjectMonthlySchema,
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: getProjectMonthlyOp.scope,
    });
    const pathParsed = getProjectMonthlyOp.parsePath!(await params);
    const queryParsed = getProjectMonthlyOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const project_id = Number.parseInt(pathParsed.id, 10);

    const breakdown = await computeProjectMonthly(project_id, queryParsed.month);
    if (!breakdown) {
      throw NotFound(`project not found: ${project_id}`);
    }

    const body = getProjectMonthlyOp.response.parse({
      project_id: breakdown.project_id,
      project_name: breakdown.project_name,
      billing_model: breakdown.billing_model,
      month: breakdown.month,
      working_days_in_month: breakdown.working_days_in_month,
      agreed_amount_eur: breakdown.agreed_amount_eur ?? null,
      revenue: (breakdown.revenue as string | null) ?? null,
      cost: breakdown.cost,
      margin: (breakdown.margin as string | null) ?? null,
      margin_pct: (breakdown.margin_pct as string | null) ?? null,
      burdened_cost: breakdown.burdened_cost,
      burdened_margin: (breakdown.burdened_margin as string | null) ?? null,
      cumulative_recognized_revenue:
        (breakdown.cumulative_recognized_revenue as string | null) ?? null,
      cumulative_margin: (breakdown.cumulative_margin as string | null) ?? null,
      tracked_hours: breakdown.tracked_hours as string,
      freelancer_hours: (breakdown.freelancer_hours as string | undefined) ?? "0.00",
      has_personio_mapping: Boolean(breakdown.has_personio_mapping),
      cumulative_revenue:
        (breakdown.cumulative_revenue as string | null) ?? null,
      cumulative_cost: (breakdown.cumulative_cost as string | null) ?? null,
      cumulative_burdened_cost:
        (breakdown.cumulative_burdened_cost as string | null) ?? null,
      cumulative_burdened_margin:
        (breakdown.cumulative_burdened_margin as string | null) ?? null,
      lifetime_tracked_person_days:
        (breakdown.lifetime_tracked_person_days as string | null) ?? null,
      tracked_hours_lifetime:
        (breakdown.tracked_hours_lifetime as string | null) ?? null,
      assignments: (breakdown.assignments as Array<Record<string, unknown>>).map(
        (a) => ({
          assignment_id: a.assignment_id as number,
          kind: a.kind as "employee" | "freelancer",
          employee_id: (a.employee_id as number | null) ?? null,
          freelancer_id: (a.freelancer_id as number | null) ?? null,
          who_name: (a.who_name as string | null) ?? null,
          profile: (a.profile as string | null) ?? null,
          allocation_pct: a.allocation_pct as string,
          start_date: (a.assignment_start_date as string | null) ?? null,
          end_date: (a.assignment_end_date as string | null) ?? null,
          tracked_hours: (a.tracked_hours as string | null) ?? null,
          revenue: (a.revenue as string | null) ?? null,
          cost: a.cost as string,
          margin: (a.margin as string | null) ?? null,
        }),
      ),
    });

    await audit(ctx, {
      action: "agent_get_project_monthly",
      target_type: "project",
      target_id: project_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: getProjectMonthlyOp.path,
      project_id,
      month: queryParsed.month,
    });

    return body;
  });
}
