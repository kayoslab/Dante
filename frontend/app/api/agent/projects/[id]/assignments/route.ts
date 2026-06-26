/** Assignment write endpoint — create an allocation under a project.
 *
 * Wraps `insertAssignment` from `lib/db/queries/assignment.ts`. Same
 * shape as `insertAssignmentAction` on the web: either `employee_id`
 * or `freelancer_id` (XOR), profile + allocation_pct + dates. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { IsoDateString } from "@/lib/agent/_validation";
import { NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { insertAssignment } from "@/lib/db/queries/assignment";
import { employeeExists } from "@/lib/db/queries/employee";
import { freelancerExists } from "@/lib/db/queries/freelancer";
import { projectExists } from "@/lib/db/queries/project";
import { log } from "@/lib/logger";

const PathParamsSchema = z.object({
  id: z.string().regex(/^\d+$/).openapi({ example: "42" }),
});

const CreateAssignmentBodySchema = z
  .object({
    employee_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({
        example: 314,
        description:
          "Internal employee. Mutually exclusive with `freelancer_id`. " +
          "Get via `matchEmployees`.",
      }),
    freelancer_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({
        example: 27,
        description:
          "Freelancer. Mutually exclusive with `employee_id`. Get via " +
          "`matchFreelancers`.",
      }),
    profile: z
      .string()
      .trim()
      .min(1)
      .max(50)
      .nullable()
      .optional()
      .openapi({
        example: "Senior",
        description:
          "Profile / role label. REQUIRED for freelancer assignments " +
          "(matches a rate-card entry on the project or framework). " +
          "Employee assignments may omit it.",
      }),
    allocation_pct: z
      .string()
      .regex(/^(0|0?\.\d{1,4}|1(\.0{1,4})?)$/)
      .openapi({
        example: "1.0",
        description:
          "Fraction of a full-time allocation, 0..1 as decimal " +
          "string. `1.0` = 100%. Defaults to `1.0` if omitted.",
      })
      .default("1.0"),
    start_date: IsoDateString.openapi({ example: "2026-07-01" }),
    end_date: IsoDateString
      .nullable()
      .optional()
      .openapi({
        example: "2026-12-31",
        description:
          "Open-ended assignments leave this null. For PO-driven " +
          "allocations always set it to the PO end date.",
      }),
    daily_rate_override_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    daily_cost_override_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable()
      .optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .openapi("AgentCreateAssignmentRequest");

const CreateAssignmentResponseSchema = z
  .object({
    assignment_id: z.number().int().openapi({ example: 1337 }),
    project_id: z.number().int(),
    employee_id: z.number().int().nullable(),
    freelancer_id: z.number().int().nullable(),
  })
  .openapi("AgentCreateAssignmentResponse");

export const createAssignmentOp = defineAgentOp({
  method: "post",
  path: "/projects/{id}/assignments",
  operationId: "createAssignment",
  summary: "Create a project allocation.",
  description:
    "Insert a new allocation under an existing project. Exactly one " +
    "of `employee_id` or `freelancer_id` must be set. Use " +
    "`matchEmployees` / `matchFreelancers` to resolve names from a " +
    "PO before calling. Source is always `manual`. Manager + admin " +
    "scope; parks for explicit confirmation.",
  scope: "write:allocations",
  pathParams: PathParamsSchema,
  body: CreateAssignmentBodySchema,
  response: CreateAssignmentResponseSchema,
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: createAssignmentOp.scope,
    });
    const pathParsed = createAssignmentOp.parsePath!(await params);
    const project_id = Number.parseInt(pathParsed.id, 10);

    const raw = await req.json().catch(() => null);
    const input = createAssignmentOp.parseBody(raw);

    const hasEmp = input.employee_id != null;
    const hasFree = input.freelancer_id != null;
    if (hasEmp === hasFree) {
      throw Validation(
        "Exactly one of employee_id or freelancer_id must be set, not both and not neither.",
      );
    }
    if (hasFree && (input.profile == null || input.profile.length === 0)) {
      // Matches `lib/actions/assignment.ts` — freelancer rows price
      // off a rate-card profile and have no role_tier fallback, so
      // an empty profile would leave the assignment unpriced.
      throw Validation(
        "freelancer assignments require profile (no role_tier fallback)",
      );
    }
    if (input.end_date && input.end_date < input.start_date) {
      throw Validation(
        `end_date ${input.end_date} is before start_date ${input.start_date}.`,
      );
    }

    if (!(await projectExists(project_id))) {
      throw NotFound(`Project ${project_id} does not exist.`);
    }
    if (hasEmp && !(await employeeExists(input.employee_id!))) {
      throw NotFound(`Employee ${input.employee_id} does not exist.`);
    }
    if (hasFree && !(await freelancerExists(input.freelancer_id!))) {
      throw NotFound(`Freelancer ${input.freelancer_id} does not exist.`);
    }

    const { assignment_id } = await insertAssignment({
      project_id,
      employee_id: input.employee_id ?? null,
      freelancer_id: input.freelancer_id ?? null,
      profile: input.profile ?? null,
      allocation_pct: input.allocation_pct,
      start_date: input.start_date,
      end_date: input.end_date ?? null,
      daily_rate_override_eur: input.daily_rate_override_eur ?? null,
      daily_cost_override_eur: input.daily_cost_override_eur ?? null,
      notes: input.notes ?? null,
    });

    const body = createAssignmentOp.response.parse({
      assignment_id,
      project_id,
      employee_id: input.employee_id ?? null,
      freelancer_id: input.freelancer_id ?? null,
    });

    await audit(ctx, {
      action: "agent_create_assignment",
      target_type: "assignment",
      target_id: assignment_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: createAssignmentOp.path,
      method: "POST",
      project_id,
      assignment_id,
    });

    return body;
  });
}
