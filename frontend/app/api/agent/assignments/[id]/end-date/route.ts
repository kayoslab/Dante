/** Assignment extension — set/update an assignment's end_date.
 *
 * Wraps `setAssignmentEndDate`. Used by the PO-extension workflow when
 * an existing allocation needs to be lengthened (or shortened) to
 * match a new purchase order. Same role gate as
 * `endAssignmentAction` on the web. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import {
  getAssignmentStartDate,
  setAssignmentEndDate,
} from "@/lib/db/queries/assignment";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "1337" }),
});

const UpdateEndDateBodySchema = z
  .object({
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .openapi({
        example: "2027-06-30",
        description:
          "New end date for the assignment. Must be on or after the " +
          "assignment's start_date.",
      }),
  })
  .openapi("AgentUpdateAssignmentEndDateRequest");

const UpdateEndDateResponseSchema = z
  .object({
    assignment_id: z.number().int(),
    end_date: z.string(),
  })
  .openapi("AgentUpdateAssignmentEndDateResponse");

export const updateAssignmentEndDateOp = defineAgentOp({
  method: "patch",
  path: "/assignments/{id}/end-date",
  operationId: "updateAssignmentEndDate",
  summary: "Extend / change an allocation's end date.",
  description:
    "Update an existing allocation's `end_date` — typically used to " +
    "extend a roll-on under a new purchase order. The new date must " +
    "be on or after the assignment's start_date. Manager + admin " +
    "scope; parks for explicit confirmation.",
  scope: "write:allocations",
  pathParams: PathParamsSchema,
  body: UpdateEndDateBodySchema,
  response: UpdateEndDateResponseSchema,
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: updateAssignmentEndDateOp.scope,
    });
    const pathParsed = updateAssignmentEndDateOp.parsePath!(await params);
    const assignment_id = Number.parseInt(pathParsed.id, 10);

    const raw = await req.json().catch(() => null);
    const input = updateAssignmentEndDateOp.parseBody(raw);

    const existing = await getAssignmentStartDate(assignment_id);
    if (existing === null) {
      throw NotFound(`Assignment ${assignment_id} does not exist.`);
    }
    if (existing.start_date && input.end_date < existing.start_date) {
      throw Validation(
        `end_date ${input.end_date} is before start_date ${existing.start_date}.`,
      );
    }

    await setAssignmentEndDate(assignment_id, input.end_date);

    const body = updateAssignmentEndDateOp.response.parse({
      assignment_id,
      end_date: input.end_date,
    });

    await audit(ctx, {
      action: "agent_set_assignment_end_date",
      target_type: "assignment",
      target_id: assignment_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: updateAssignmentEndDateOp.path,
      method: "PATCH",
      assignment_id,
      end_date: input.end_date,
    });

    return body;
  });
}
