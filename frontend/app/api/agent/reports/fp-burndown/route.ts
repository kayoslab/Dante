/** Fixed-price burn-down state across every active FP project. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { computeFpBurndownForMonth } from "@/lib/db/queries/fp-burndown";
import { log } from "@/lib/logger";

const QuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .openapi({ example: "2026-06" }),
});

const FpBurndownProjectSchema = z
  .object({
    project_id: z.number().int(),
    project_name: z.string(),
    customer_name: z.string(),
    recognition_method: z.enum(["tracked_hours", "timeline", "none"]),
    agreed_amount: z.string().nullable(),
    time_budget_hours: z.number().nullable(),
    planned_end_date: z.string().nullable(),
    tracked_hours: z.string(),
    cumulative_cost: z.string(),
    cumulative_recognized: z.string(),
    projected_pct: z.string().nullable().openapi({
      description:
        "(tracked + planned future) / time budget. Over 1.0 = projected overrun.",
    }),
    variance_pp: z.string().nullable(),
    status: z.enum([
      "on_track",
      "at_risk",
      "time_exhausted",
      "margin_negative",
      "not_started",
      "ended",
      "no_rule",
    ]),
  })
  .openapi("AgentFpBurndownProject");

const FpBurndownResponseSchema = z.object({
  month: z.string(),
  as_of_date: z.string(),
  summary: z.object({
    n_active: z.number().int(),
    n_margin_negative: z.number().int(),
    n_time_exhausted: z.number().int(),
    n_at_risk: z.number().int(),
    total_agreed: z.string(),
    total_recognized: z.string(),
    total_cost: z.string(),
  }),
  projects: z.array(FpBurndownProjectSchema),
});

export const getFpBurndownOp = defineAgentOp({
  method: "get",
  path: "/reports/fp-burndown",
  operationId: "getFpBurndown",
  summary: "Fixed-price burn-down snapshot.",
  description:
    "Status of every active fixed-price project as of the given " +
    "month's end (or today, if the month is current): cumulative cost " +
    "vs recognized revenue, projected end position, status flag. Use " +
    "to surface projects at risk or already over budget.",
  scope: "read:reports",
  queryParams: QuerySchema,
  response: FpBurndownResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: getFpBurndownOp.scope,
    });
    const queryParsed = getFpBurndownOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    const today = new Date().toISOString().slice(0, 10);
    const raw = await computeFpBurndownForMonth(queryParsed.month, today);
    const body = getFpBurndownOp.response.parse({
      month: raw.month,
      as_of_date: raw.as_of_date,
      summary: raw.summary,
      projects: raw.projects.map((p) => ({
        project_id: p.project_id,
        project_name: p.project_name,
        customer_name: p.customer_name,
        recognition_method: p.recognition_method,
        agreed_amount: p.agreed_amount,
        time_budget_hours: p.time_budget_hours,
        planned_end_date: p.planned_end_date,
        tracked_hours: p.tracked_hours,
        cumulative_cost: p.cumulative_cost,
        cumulative_recognized: p.cumulative_recognized,
        projected_pct: p.projected_pct,
        variance_pp: p.variance_pp,
        status: p.status,
      })),
    });

    await audit(ctx, {
      action: "agent_get_fp_burndown",
      target_type: "month",
      target_id: queryParsed.month,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: getFpBurndownOp.path,
      month: queryParsed.month,
      result_count: body.projects.length,
    });

    return body;
  });
}
