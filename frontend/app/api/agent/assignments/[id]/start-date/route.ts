/** Assignment backdate — move an assignment's start_date.
 *
 * The companion to `updateAssignmentEndDate`: where the end-date tool
 * extends a roll-on under a new PO, this one supports back-dating an
 * allocation when the PO turns out to cover a window predating when
 * the assignment was originally entered. Manager + admin scope; parks
 * for explicit confirmation in the chat. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { IsoDateString } from "@/lib/agent/_validation";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import {
  getAssignmentDates,
  setAssignmentStartDate,
} from "@/lib/db/queries/assignment";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "1337" }),
});

const UpdateStartDateBodySchema = z
  .object({
    start_date: IsoDateString.openapi({
      example: "2026-01-12",
      description:
        "New start date for the assignment. Must be on or before the " +
        "assignment's existing end_date (if one is set). Typical use: " +
        "backdate an existing allocation to match a PO that covers a " +
        "window earlier than when the assignment was first entered.",
    }),
  })
  .openapi("AgentUpdateAssignmentStartDateRequest");

const UpdateStartDateResponseSchema = z
  .object({
    assignment_id: z.number().int(),
    start_date: z.string(),
  })
  .openapi("AgentUpdateAssignmentStartDateResponse");

export const updateAssignmentStartDateOp = defineAgentOp({
  method: "patch",
  path: "/assignments/{id}/start-date",
  operationId: "updateAssignmentStartDate",
  summary: "Move an allocation's start date (typically a backdate).",
  description:
    "Update an existing allocation's `start_date`. Use to back-date " +
    "an assignment when a PO covers a window earlier than the row's " +
    "current start. If the assignment has an end_date set, the new " +
    "start must be on or before it. Manager + admin scope; parks for " +
    "explicit confirmation.",
  scope: "write:allocations",
  pathParams: PathParamsSchema,
  body: UpdateStartDateBodySchema,
  response: UpdateStartDateResponseSchema,
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: updateAssignmentStartDateOp.scope,
    });
    const pathParsed = updateAssignmentStartDateOp.parsePath!(await params);
    const assignment_id = Number.parseInt(pathParsed.id, 10);

    const raw = await req.json().catch(() => null);
    const input = updateAssignmentStartDateOp.parseBody(raw);

    const existing = await getAssignmentDates(assignment_id);
    if (existing === null) {
      throw NotFound(`Assignment ${assignment_id} does not exist.`);
    }
    if (existing.end_date && input.start_date > existing.end_date) {
      throw Validation(
        `start_date ${input.start_date} is after end_date ${existing.end_date}.`,
      );
    }

    await setAssignmentStartDate(assignment_id, input.start_date);

    const body = updateAssignmentStartDateOp.response.parse({
      assignment_id,
      start_date: input.start_date,
    });

    await audit(ctx, {
      action: "agent_set_assignment_start_date",
      target_type: "assignment",
      target_id: assignment_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: updateAssignmentStartDateOp.path,
      method: "PATCH",
      assignment_id,
      start_date: input.start_date,
    });

    return body;
  });
}
