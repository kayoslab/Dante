/** Update an existing project — used by the PO-extends-existing-project
 * branch in the dante-alighieri workflows when a new purchase order
 * extends the planned dates, tops up the agreed amount on an FP, moves
 * the project under a different framework, or rolls a status forward.
 *
 * Wraps `updateProject` from `lib/db/queries/project.ts`. Same role
 * gate as `updateProjectAction` on the web (manager+ via scope) and
 * the same partial-update semantics: any field omitted from the body
 * is left alone, `null` means "clear" for nullable fields (e.g.
 * `framework_id: null` removes the framework link).
 *
 * customer_id is intentionally NOT updateable. Moving a project to a
 * different customer is a significant operation that should go
 * through `mergeProjects` (or a deliberate manual step), not be
 * smuggled into an update via the agent. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { IsoDateString } from "@/lib/agent/_validation";
import { Conflict, NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { frameworkExists } from "@/lib/db/queries/framework";
import {
  findProjectByCustomerAndName,
  getFrameworkCustomerId,
  getProjectCustomerId,
  getProjectName,
  updateProject,
} from "@/lib/db/queries/project";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "42" }),
});

const UpdateProjectBodySchema = z
  .object({
    framework_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({
        example: 12,
        description:
          "Move the project under a different framework, or pass " +
          "`null` to remove the framework link. The framework MUST " +
          "belong to the project's existing customer — the route " +
          "validates this. Omit to leave unchanged.",
      }),
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .openapi({
        example: "Acme: Capacity Study 2026-H2 (extended)",
        description: "Rename the project. Must remain unique within the customer.",
      }),
    agreed_amount_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable()
      .optional()
      .openapi({
        example: "150000.00",
        description:
          "FP top-up amount as a decimal string. Pass `null` to clear " +
          "the agreed amount (typically when switching billing model).",
      }),
    planned_start_date: IsoDateString
      .nullable()
      .optional()
      .openapi({ example: "2026-07-01" }),
    planned_end_date: IsoDateString
      .nullable()
      .optional()
      .openapi({
        example: "2027-06-30",
        description:
          "Extend (or shorten) the planned end. The PO-extension flow " +
          "uses this to push the project end out to the new PO date.",
      }),
    status: z
      .enum(["active", "on_hold", "completed", "cancelled"])
      .optional()
      .openapi({ example: "active" }),
    notes: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional()
      .openapi({
        example: "Extended by PO 2026-12 dated 2026-09-15.",
        description:
          "Free-text note. Replaces the existing notes — fetch them " +
          "first via `listProjects` / `getProjectMonthly` if you need " +
          "to append rather than overwrite.",
      }),
  })
  .openapi("AgentUpdateProjectRequest");

const UpdateProjectResponseSchema = z
  .object({
    project_id: z.number().int(),
    name: z.string(),
    customer_id: z.number().int(),
    changes: z
      .array(z.string())
      .openapi({
        description:
          "Names of the fields actually changed by this call (a no-op " +
          "update returns an empty array — useful when the model " +
          "submits a body that already matches current state).",
      }),
  })
  .openapi("AgentUpdateProjectResponse");

export const updateProjectOp = defineAgentOp({
  method: "patch",
  path: "/projects/{id}",
  operationId: "updateProject",
  summary: "Update an existing project.",
  description:
    "Partial update of a project's metadata. Any field omitted is " +
    "left unchanged; `null` clears nullable fields. Validates that a " +
    "new framework_id belongs to the project's customer, and that a " +
    "new name doesn't collide with another project under the same " +
    "customer. Manager + admin scope; parks the run for explicit " +
    "confirmation in the chat.",
  scope: "write:projects",
  pathParams: PathParamsSchema,
  body: UpdateProjectBodySchema,
  response: UpdateProjectResponseSchema,
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: updateProjectOp.scope });
    const pathParsed = updateProjectOp.parsePath!(await params);
    const project_id = Number.parseInt(pathParsed.id, 10);

    const raw = await req.json().catch(() => null);
    const input = updateProjectOp.parseBody(raw);

    const currentCustomerId = await getProjectCustomerId(project_id);
    if (currentCustomerId === null) {
      throw NotFound(`Project ${project_id} does not exist.`);
    }

    // Date-pair guard. We only have both dates if BOTH are in this
    // body — partial updates that only touch one date can't cross-
    // check against the existing value here without an extra read,
    // and the DB has no constraint either. Acceptable: the same gap
    // exists in the createProject path.
    if (
      input.planned_start_date &&
      input.planned_end_date &&
      input.planned_end_date < input.planned_start_date
    ) {
      throw Validation(
        `planned_end_date ${input.planned_end_date} is before planned_start_date ${input.planned_start_date}.`,
      );
    }

    const updates: Record<string, unknown> = {};

    if (input.framework_id !== undefined) {
      if (input.framework_id === null) {
        updates.framework_id = null;
      } else {
        if (!(await frameworkExists(input.framework_id))) {
          throw NotFound(`Framework ${input.framework_id} does not exist.`);
        }
        const fwCustomerId = await getFrameworkCustomerId(input.framework_id);
        if (fwCustomerId !== currentCustomerId) {
          throw Conflict(
            `Framework ${input.framework_id} belongs to customer ${fwCustomerId}, not ${currentCustomerId}.`,
          );
        }
        updates.framework_id = input.framework_id;
      }
    }
    if (input.name !== undefined) {
      const existing = await findProjectByCustomerAndName(
        currentCustomerId,
        input.name,
      );
      if (existing !== null && existing !== project_id) {
        throw Conflict(
          `Project "${input.name}" already exists for customer ${currentCustomerId} (project_id ${existing}).`,
        );
      }
      updates.name = input.name;
    }
    if (input.agreed_amount_eur !== undefined) {
      updates.agreed_amount_eur = input.agreed_amount_eur;
    }
    if (input.planned_start_date !== undefined) {
      updates.planned_start_date = input.planned_start_date;
    }
    if (input.planned_end_date !== undefined) {
      updates.planned_end_date = input.planned_end_date;
    }
    if (input.status !== undefined) {
      updates.status = input.status;
    }
    if (input.notes !== undefined) {
      updates.notes = input.notes;
    }

    if (Object.keys(updates).length > 0) {
      await updateProject(project_id, updates);
    }

    // Read back the (possibly new) name for the response so the
    // model can refer to the project in its follow-up message
    // without an extra round trip.
    const name = (await getProjectName(project_id)) ?? "";

    const body = updateProjectOp.response.parse({
      project_id,
      name,
      customer_id: currentCustomerId,
      changes: Object.keys(updates),
    });

    await audit(ctx, {
      action: "agent_update_project",
      target_type: "project",
      target_id: project_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: updateProjectOp.path,
      method: "PATCH",
      project_id,
      changes: Object.keys(updates),
    });

    return body;
  });
}
