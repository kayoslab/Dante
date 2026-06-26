/** Slim LLM-friendly list of active projects.
 *
 * The OpenAPI spec for this operation is derived from the Zod schemas
 * via `defineAgentOp` — same source-of-truth as the runtime
 * validation. Agent runtimes (Vercel EVE, Claude Desktop, anything
 * else that consumes `/api/agent/openapi.json`) discover this as the
 * tool `dante__listProjects`. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { Conflict, NotFound, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { customerExists } from "@/lib/db/queries/customer";
import { frameworkExists } from "@/lib/db/queries/framework";
import { listActiveProjectsForPortfolio } from "@/lib/db/queries/project-monthly";
import {
  findProjectByCustomerAndName,
  getFrameworkCustomerId,
  insertProject,
  insertProjectRate,
} from "@/lib/db/queries/project";
import { log } from "@/lib/logger";

const ProjectListItemSchema = z
  .object({
    project_id: z.number().int().openapi({ example: 42 }),
    name: z.string().openapi({ example: "Acme: Capacity Study" }),
    billing_model: z.enum(["fixed_price", "time_and_material"]),
    customer_id: z.number().int().openapi({ example: 7 }),
    customer_name: z.string().openapi({ example: "Acme Holding AG" }),
  })
  .openapi("AgentProjectListItem");

const ListProjectsResponseSchema = z.object({
  items: z.array(ProjectListItemSchema),
  count: z.number().int(),
});

export const listProjectsOp = defineAgentOp({
  method: "get",
  path: "/projects",
  operationId: "listProjects",
  summary: "List active projects.",
  description:
    "Every active project the caller's role can see — slim shape " +
    "(project_id, name, billing model, customer). Use to discover the " +
    "portfolio before drilling into a specific project via " +
    "`getProjectMonthly`.",
  scope: "read:projects",
  response: ListProjectsResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: listProjectsOp.scope });

    const rows = await listActiveProjectsForPortfolio();
    const body = listProjectsOp.response.parse({
      items: rows.map((r) => ({
        project_id: r.project_id,
        name: r.name,
        billing_model:
          r.billing_model === "fixed_price"
            ? ("fixed_price" as const)
            : ("time_and_material" as const),
        customer_id: r.customer_id,
        customer_name: r.customer_name,
      })),
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_list_projects",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: listProjectsOp.path,
      result_count: body.count,
    });

    return body;
  });
}

// ---------------------------------------------------------------------------
// createProject — POST /api/agent/projects
// ---------------------------------------------------------------------------

const ProjectRateInputSchema = z
  .object({
    profile: z.string().trim().min(1).max(50).openapi({ example: "Senior" }),
    valid_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .openapi({ example: "2026-07-01" }),
    daily_rate_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .openapi({
        example: "1250.00",
        description:
          "Daily rate in EUR as a decimal string (no currency symbol). " +
          "Strings are used through the stack — see AGENTS.md § Money & " +
          "decimals — to avoid float drift.",
      }),
  })
  .openapi("AgentProjectRateInput");

const CreateProjectBodySchema = z
  .object({
    customer_id: z
      .number()
      .int()
      .positive()
      .openapi({
        example: 7,
        description:
          "Existing customer. Get from `matchCustomers` or " +
          "`listCustomers`. If the customer doesn't exist yet, first " +
          "call `createCustomer`.",
      }),
    framework_id: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .openapi({
        example: 12,
        description:
          "Optional framework agreement this project lives under. Must " +
          "belong to the same `customer_id` — the route validates that.",
      }),
    name: z.string().trim().min(1).max(200).openapi({
      example: "Acme: Capacity Study 2026-H2",
    }),
    billing_model: z.enum(["time_and_material", "fixed_price"]).openapi({
      example: "time_and_material",
    }),
    agreed_amount_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .nullable()
      .optional()
      .openapi({
        example: "120000.00",
        description:
          "Total agreed amount in EUR as a decimal string. Required " +
          "for `fixed_price`; ignored (set null) for `time_and_material`.",
      }),
    planned_start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .openapi({ example: "2026-07-01" }),
    planned_end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .openapi({ example: "2026-12-31" }),
    status: z
      .enum(["active", "on_hold", "completed", "cancelled"])
      .optional()
      .openapi({ example: "active" }),
    notes: z.string().trim().max(2_000).nullable().optional(),
    rates: z
      .array(ProjectRateInputSchema)
      .max(50)
      .optional()
      .openapi({
        description:
          "Per-profile rate cards to insert alongside the project. " +
          "Optional; omit when the project inherits its rates from the " +
          "framework agreement.",
      }),
  })
  .openapi("AgentCreateProjectRequest");

const CreateProjectResponseSchema = z
  .object({
    project_id: z.number().int().openapi({ example: 84 }),
    name: z.string(),
    customer_id: z.number().int(),
    framework_id: z.number().int().nullable(),
    rates_inserted: z.number().int(),
  })
  .openapi("AgentCreateProjectResponse");

export const createProjectOp = defineAgentOp({
  method: "post",
  path: "/projects",
  operationId: "createProject",
  summary: "Create a project.",
  description:
    "Create a new project. Validates the customer (and framework, if " +
    "supplied) exist and that the (customer, name) pair is unique. " +
    "Optionally inserts per-profile rate cards in the same call. " +
    "ALWAYS call `matchProjects` first to discover an existing project " +
    "that might be the same and surface it in the HITL confirmation. " +
    "Manager + admin scope; parks the run for explicit confirmation.",
  scope: "write:projects",
  body: CreateProjectBodySchema,
  response: CreateProjectResponseSchema,
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: createProjectOp.scope });
    const raw = await req.json().catch(() => null);
    const input = createProjectOp.parseBody(raw);

    if (!(await customerExists(input.customer_id))) {
      throw NotFound(`Customer ${input.customer_id} does not exist.`);
    }
    if (input.framework_id != null) {
      if (!(await frameworkExists(input.framework_id))) {
        throw NotFound(`Framework ${input.framework_id} does not exist.`);
      }
      const fwCustomerId = await getFrameworkCustomerId(input.framework_id);
      if (fwCustomerId !== input.customer_id) {
        throw Conflict(
          `Framework ${input.framework_id} belongs to customer ${fwCustomerId}, not ${input.customer_id}.`,
        );
      }
    }
    const existing = await findProjectByCustomerAndName(
      input.customer_id,
      input.name,
    );
    if (existing !== null) {
      throw Conflict(
        `Project "${input.name}" already exists for customer ${input.customer_id} (project_id ${existing}).`,
      );
    }

    const project_id = await insertProject({
      customer_id: input.customer_id,
      framework_id: input.framework_id ?? null,
      name: input.name,
      billing_model: input.billing_model,
      agreed_amount_eur: input.agreed_amount_eur ?? null,
      planned_start_date: input.planned_start_date ?? null,
      planned_end_date: input.planned_end_date ?? null,
      status: input.status ?? "active",
      notes: input.notes ?? null,
    });

    let ratesInserted = 0;
    if (input.rates && input.rates.length > 0) {
      for (const r of input.rates) {
        await insertProjectRate({
          project_id,
          profile: r.profile,
          valid_from: r.valid_from,
          daily_rate_eur: r.daily_rate_eur,
        });
        ratesInserted++;
      }
    }

    const body = createProjectOp.response.parse({
      project_id,
      name: input.name,
      customer_id: input.customer_id,
      framework_id: input.framework_id ?? null,
      rates_inserted: ratesInserted,
    });

    await audit(ctx, {
      action: "agent_create_project",
      target_type: "project",
      target_id: project_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: createProjectOp.path,
      method: "POST",
      project_id,
      rates_inserted: ratesInserted,
    });

    return body;
  });
}
