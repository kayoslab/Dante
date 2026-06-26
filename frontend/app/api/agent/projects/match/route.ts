/** Fuzzy lookup for an existing project by name (optionally scoped
 * to a customer).
 *
 * The PO workflow uses this to find an existing project before
 * creating a new one. Substring ILIKE match — future work could swap
 * to `pg_trgm` once enabled. Read-only — reuses `read:projects`. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { matchProjectsByName } from "@/lib/db/queries/project";
import { log } from "@/lib/logger";

const QueryParamsSchema = z.object({
  q: z.string().trim().min(1).max(120).openapi({
    example: "Capacity Study",
    description: "Free-text search across project names. ILIKE substring.",
  }),
  customer_id: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({
      example: "7",
      description: "Optional customer to scope the search to.",
    }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({ example: "5" }),
});

const MatchItemSchema = z
  .object({
    project_id: z.number().int(),
    name: z.string(),
    customer_id: z.number().int(),
    customer_name: z.string(),
    billing_model: z.enum(["fixed_price", "time_and_material"]),
    status: z.string(),
  })
  .openapi("AgentProjectMatchItem");

const MatchResponseSchema = z.object({
  items: z.array(MatchItemSchema),
  count: z.number().int(),
});

export const matchProjectsOp = defineAgentOp({
  method: "get",
  path: "/projects/match",
  operationId: "matchProjects",
  summary: "Fuzzy project lookup.",
  description:
    "Returns projects whose names contain the query string. Pass " +
    "`customer_id` to scope to one customer. Use BEFORE " +
    "`createProject` when ingesting a PO to detect that the project " +
    "already exists (then drive the allocation-extension path).",
  scope: "read:projects",
  queryParams: QueryParamsSchema,
  response: MatchResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: matchProjectsOp.scope });
    const query = matchProjectsOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const limit = Math.min(
      query.limit ? Number.parseInt(query.limit, 10) : 5,
      20,
    );
    const customerId = query.customer_id
      ? Number.parseInt(query.customer_id, 10)
      : null;

    const rows = await matchProjectsByName(query.q, limit, customerId);

    const body = matchProjectsOp.response.parse({
      items: rows.map((r) => ({
        ...r,
        billing_model:
          r.billing_model === "fixed_price"
            ? ("fixed_price" as const)
            : ("time_and_material" as const),
      })),
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_match_projects",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: matchProjectsOp.path,
      result_count: body.count,
    });

    return body;
  });
}
