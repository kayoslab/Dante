/** Update an existing freelancer.
 *
 * Wraps `updateFreelancerById` from `lib/db/queries/freelancer.ts`.
 * Same role gate as `updateFreelancerAction` on the web (manager+),
 * same partial-update semantics: any field omitted is left alone;
 * `null` clears the nullable fields (`contact_email`, `notes`). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { Conflict, NotFound, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import {
  findFreelancerIdByName,
  freelancerExists,
  getFreelancerName,
  updateFreelancerById,
} from "@/lib/db/queries/freelancer";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "42" }),
});

const UpdateFreelancerBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .openapi({
        example: "Maria Rossi",
        description:
          "Rename the freelancer. Must remain unique across freelancers.",
      }),
    daily_cost_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .optional()
      .openapi({
        example: "980.00",
        description:
          "New daily cost. Change here rewrites the cost basis for " +
          "every future margin calculation involving this freelancer — " +
          "historical margins already computed for prior months don't " +
          "change (they used the value in effect at compute time).",
      }),
    status: z
      .enum(["active", "inactive"])
      .optional()
      .openapi({
        example: "active",
        description:
          "Set `inactive` to soft-retire a freelancer without deleting. " +
          "Existing assignments and time entries are preserved either " +
          "way; this only affects the picker's default filter.",
      }),
    contact_email: z
      .string()
      .trim()
      .max(320)
      .nullable()
      .optional(),
    notes: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional(),
  })
  .openapi("AgentUpdateFreelancerRequest");

const UpdateFreelancerResponseSchema = z
  .object({
    freelancer_id: z.number().int(),
    name: z.string(),
    changes: z
      .array(z.string())
      .openapi({
        description:
          "Names of the fields actually changed by this call (empty " +
          "array on a no-op).",
      }),
  })
  .openapi("AgentUpdateFreelancerResponse");

export const updateFreelancerOp = defineAgentOp({
  method: "patch",
  path: "/freelancers/{id}",
  operationId: "updateFreelancer",
  summary: "Update an existing freelancer.",
  description:
    "Partial update of a freelancer's metadata. Any field omitted from " +
    "the body is left unchanged; `null` clears nullable fields " +
    "(`contact_email`, `notes`). Renaming enforces the same name-" +
    "uniqueness the create endpoint does. Manager + admin scope; parks " +
    "for explicit confirmation.",
  scope: "write:freelancers",
  pathParams: PathParamsSchema,
  body: UpdateFreelancerBodySchema,
  response: UpdateFreelancerResponseSchema,
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: updateFreelancerOp.scope });
    const pathParsed = updateFreelancerOp.parsePath!(await params);
    const freelancer_id = Number.parseInt(pathParsed.id, 10);

    const raw = await req.json().catch(() => null);
    const input = updateFreelancerOp.parseBody(raw);

    if (!(await freelancerExists(freelancer_id))) {
      throw NotFound(`Freelancer ${freelancer_id} does not exist.`);
    }

    const updates: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const collide = await findFreelancerIdByName(input.name);
      if (collide !== null && collide !== freelancer_id) {
        throw Conflict(
          `Freelancer "${input.name}" already exists (freelancer_id ${collide}).`,
        );
      }
      updates.name = input.name;
    }
    if (input.daily_cost_eur !== undefined) {
      updates.daily_cost_eur = input.daily_cost_eur;
    }
    if (input.status !== undefined) updates.status = input.status;
    if (input.contact_email !== undefined) updates.contact_email = input.contact_email;
    if (input.notes !== undefined) updates.notes = input.notes;

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date();
      await updateFreelancerById(freelancer_id, updates);
    }

    const changes = Object.keys(updates).filter((k) => k !== "updated_at");
    const name = (await getFreelancerName(freelancer_id)) ?? "";
    const body = updateFreelancerOp.response.parse({
      freelancer_id,
      name,
      changes,
    });

    await audit(ctx, {
      action: "agent_update_freelancer",
      target_type: "freelancer",
      target_id: freelancer_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: updateFreelancerOp.path,
      method: "PATCH",
      freelancer_id,
      changes,
    });

    return body;
  });
}
