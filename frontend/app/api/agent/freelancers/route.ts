/** Create a new freelancer.
 *
 * Wraps `insertFreelancer` from `lib/db/queries/freelancer.ts`. Same
 * role gate as `createFreelancerAction` on the web (manager+), and
 * the same uniqueness check on `name` before insert. Closes the gap
 * the EVE instructions previously called out: the person-resolution
 * order in Workflow 2 had to hand off to the web UI whenever a
 * freelancer needed setup because there was no agent tool for it. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { Conflict, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import {
  findFreelancerIdByName,
  insertFreelancer,
} from "@/lib/db/queries/freelancer";
import { log } from "@/lib/logger";

const CreateFreelancerBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .openapi({
        example: "Maria Rossi",
        description:
          "Freelancer's full name. Must be unique across all " +
          "freelancers — the route rejects with 409 on a case-sensitive " +
          "collision. When ingesting a PO that names a consultant, ALWAYS " +
          "call `matchFreelancers` first to check for a near-match before " +
          "creating.",
      }),
    daily_cost_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .openapi({
        example: "950.00",
        description:
          "The freelancer's daily cost to us — what we pay them, NOT " +
          "the daily rate we bill the customer. Used as the cost basis " +
          "for margin calculations; there's no separate salary/burden " +
          "path for freelancers. Decimal string with 0-2 fraction digits.",
      }),
    contact_email: z
      .string()
      .trim()
      .max(320)
      .nullable()
      .optional()
      .openapi({ example: "maria.rossi@example.com" }),
    notes: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional()
      .openapi({
        example: "Introduced via June 2026 pentest engagement.",
        description:
          "Optional provenance note — how the freelancer entered the " +
          "roster, contact context, or anything the next operator should " +
          "know.",
      }),
  })
  .openapi("AgentCreateFreelancerRequest");

const CreateFreelancerResponseSchema = z
  .object({
    freelancer_id: z.number().int().openapi({ example: 42 }),
    name: z.string(),
    daily_cost_eur: z.string(),
  })
  .openapi("AgentCreateFreelancerResponse");

export const createFreelancerOp = defineAgentOp({
  method: "post",
  path: "/freelancers",
  operationId: "createFreelancer",
  summary: "Create a freelancer.",
  description:
    "Create a brand-new freelancer with a daily cost. Name must not " +
    "already exist — call `matchFreelancers` first to catch spelling " +
    "variants before hitting a 409. Once created, the freelancer can " +
    "be attached to a project via `createAssignment` with " +
    "`freelancer_id`. Manager + admin scope; parks for explicit " +
    "confirmation in the chat.",
  scope: "write:freelancers",
  body: CreateFreelancerBodySchema,
  response: CreateFreelancerResponseSchema,
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: createFreelancerOp.scope,
    });
    const raw = await req.json().catch(() => null);
    const input = createFreelancerOp.parseBody(raw);

    const existing = await findFreelancerIdByName(input.name);
    if (existing !== null) {
      throw Conflict(
        `Freelancer "${input.name}" already exists (freelancer_id ${existing}).`,
      );
    }

    const now = new Date();
    const freelancer_id = await insertFreelancer({
      name: input.name,
      daily_cost_eur: input.daily_cost_eur,
      status: "active",
      contact_email: input.contact_email ?? null,
      notes: input.notes ?? null,
      created_at: now,
      updated_at: now,
    });

    const body = createFreelancerOp.response.parse({
      freelancer_id,
      name: input.name,
      daily_cost_eur: input.daily_cost_eur,
    });

    await audit(ctx, {
      action: "agent_create_freelancer",
      target_type: "freelancer",
      target_id: freelancer_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: createFreelancerOp.path,
      method: "POST",
      freelancer_id,
    });

    return body;
  });
}
