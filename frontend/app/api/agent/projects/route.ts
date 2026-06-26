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
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { listActiveProjectsForPortfolio } from "@/lib/db/queries/project-monthly";
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
