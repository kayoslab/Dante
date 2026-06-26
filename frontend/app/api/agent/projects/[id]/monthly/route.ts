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
    tracked_hours: z.string(),
    has_personio_mapping: z.boolean(),
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
      has_personio_mapping: Boolean(breakdown.has_personio_mapping),
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
