/** Fuzzy lookup for a freelancer by name.
 *
 * The freelancer-bill workflow uses this to attribute a bill to the
 * right freelancer before upserting hours. Read-only; reuses
 * `read:employees` (freelancers are visible at the same tier as
 * employees on the web). */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { matchFreelancersByName } from "@/lib/db/queries/freelancer-list";
import { log } from "@/lib/logger";

const QueryParamsSchema = z.object({
  q: z.string().trim().min(1).max(120).openapi({ example: "Schmidt" }),
  limit: z.string().regex(/^\d+$/).optional().openapi({ example: "5" }),
});

const MatchItemSchema = z
  .object({
    freelancer_id: z.number().int(),
    name: z.string(),
    status: z.string(),
    contact_email: z.string().nullable(),
  })
  .openapi("AgentFreelancerMatchItem");

const MatchResponseSchema = z.object({
  items: z.array(MatchItemSchema),
  count: z.number().int(),
});

export const matchFreelancersOp = defineAgentOp({
  method: "get",
  path: "/freelancers/match",
  operationId: "matchFreelancers",
  summary: "Fuzzy freelancer lookup.",
  description:
    "Returns freelancers whose names contain the query string. Use " +
    "BEFORE `upsertFreelancerHours` when attributing a bill or time " +
    "sheet to a freelancer.",
  scope: "read:employees",
  queryParams: QueryParamsSchema,
  response: MatchResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: matchFreelancersOp.scope,
    });
    const query = matchFreelancersOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const limit = Math.min(
      query.limit ? Number.parseInt(query.limit, 10) : 5,
      20,
    );

    const rows = await matchFreelancersByName(query.q, limit);

    const body = matchFreelancersOp.response.parse({
      items: rows,
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_match_freelancers",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: matchFreelancersOp.path,
      result_count: body.count,
    });

    return body;
  });
}
