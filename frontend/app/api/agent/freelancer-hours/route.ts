/** Freelancer monthly hours — upsert from bills / time sheets.
 *
 * Wraps `upsertFreelancerHours`. Same role gate as
 * `upsertFreelancerHoursAction` on the web (manager). Manual entries
 * always win over the awork sync for the same (assignment, month).
 *
 * Rejects any attempt to write hours against an employee-typed
 * assignment — only freelancer rows have a time entry table. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { IsoYearMonth } from "@/lib/agent/_validation";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import {
  getFreelancerAssignmentMeta,
  upsertFreelancerHours,
} from "@/lib/db/queries/freelancer-hours";
import { log } from "@/lib/logger";

const UpsertFreelancerHoursBodySchema = z
  .object({
    assignment_id: z
      .number()
      .int()
      .positive()
      .openapi({
        example: 1337,
        description:
          "Existing freelancer allocation. Get from `listProjects` → " +
          "matchFreelancers → existing assignment, or create one with " +
          "`createAssignment` first.",
      }),
    year_month: IsoYearMonth.openapi({
      example: "2026-06",
      description: "Year-month bucket the bill / sheet covers (UTC).",
    }),
    hours_decimal: z
      .number()
      .min(0)
      .max(744)
      .openapi({
        example: 144.5,
        description:
          "Total hours for the month as a decimal. Capped at 744 " +
          "(31 × 24) — anything higher is almost certainly a parse " +
          "mistake.",
      }),
  })
  .openapi("AgentUpsertFreelancerHoursRequest");

const UpsertFreelancerHoursResponseSchema = z
  .object({
    assignment_id: z.number().int(),
    year_month: z.string(),
    hours_decimal: z.number(),
    source: z.literal("manual"),
  })
  .openapi("AgentUpsertFreelancerHoursResponse");

export const upsertFreelancerHoursOp = defineAgentOp({
  method: "post",
  path: "/freelancer-hours",
  operationId: "upsertFreelancerHours",
  summary: "Set monthly hours for a freelancer assignment.",
  description:
    "Insert or update the monthly hours total for a freelancer " +
    "allocation, sourced from a bill or time sheet. Source is fixed " +
    "to `manual` and overrides any prior awork sync value for the " +
    "same (assignment, month). The PDF workflow should aggregate " +
    "totals per assignment per month before calling — one call per " +
    "(assignment, month). Manager + admin scope; parks for explicit " +
    "confirmation.",
  scope: "write:time_tracking",
  body: UpsertFreelancerHoursBodySchema,
  response: UpsertFreelancerHoursResponseSchema,
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: upsertFreelancerHoursOp.scope,
    });
    const raw = await req.json().catch(() => null);
    const input = upsertFreelancerHoursOp.parseBody(raw);

    const meta = await getFreelancerAssignmentMeta(input.assignment_id);
    if (meta === null) {
      throw NotFound(`Assignment ${input.assignment_id} does not exist.`);
    }
    if (meta.freelancer_id == null) {
      throw Validation(
        `Assignment ${input.assignment_id} is not a freelancer assignment — ` +
          "monthly hours apply only to freelancer allocations.",
      );
    }

    await upsertFreelancerHours({
      assignment_id: input.assignment_id,
      year_month: input.year_month,
      hours_decimal: input.hours_decimal,
      // Dante-side user_id, NOT the Cognito sub. entered_by is an FK to
      // app_user(user_id); passing cognito_sub violates the constraint
      // and the route 500s. Matches upsertFreelancerHoursAction on the
      // web (auth.ctx.user_id).
      entered_by: ctx.user_id,
    });

    const body = upsertFreelancerHoursOp.response.parse({
      assignment_id: input.assignment_id,
      year_month: input.year_month,
      hours_decimal: input.hours_decimal,
      source: "manual",
    });

    await audit(ctx, {
      action: "agent_upsert_freelancer_hours",
      target_type: "assignment",
      target_id: input.assignment_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: upsertFreelancerHoursOp.path,
      method: "POST",
      assignment_id: input.assignment_id,
      year_month: input.year_month,
      hours_decimal: input.hours_decimal,
    });

    return body;
  });
}
