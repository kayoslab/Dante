/** Fuzzy lookup for an existing customer by name.
 *
 * The PDF workflow uses this to dedupe "Acme Holding AG" against "Acme",
 * "Acme Group", etc. before falling back to `createCustomer`.
 * Substring match on `name` (ILIKE, case-insensitive); future work
 * could swap to `pg_trgm` similarity once the extension is enabled.
 *
 * Read-only — reuses `read:customers`. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { matchCustomersByName } from "@/lib/db/queries/customer";
import { log } from "@/lib/logger";

const QueryParamsSchema = z.object({
  q: z.string().trim().min(1).max(100).openapi({
    example: "Acme",
    description:
      "Free-text search across customer names. Case-insensitive " +
      "substring match.",
  }),
  limit: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .openapi({ example: "5", description: "Max results. Defaults to 5, capped at 20." }),
});

const MatchItemSchema = z
  .object({
    customer_id: z.number().int().openapi({ example: 7 }),
    name: z.string().openapi({ example: "Acme Holding AG" }),
  })
  .openapi("AgentCustomerMatchItem");

const MatchResponseSchema = z.object({
  items: z.array(MatchItemSchema),
  count: z.number().int(),
});

export const matchCustomersOp = defineAgentOp({
  method: "get",
  path: "/customers/match",
  operationId: "matchCustomers",
  summary: "Fuzzy customer lookup by name.",
  description:
    "Returns customers whose names contain the query string (case " +
    "insensitive). Use BEFORE `createCustomer` when ingesting a PDF " +
    "to avoid creating duplicates of an already-existing customer " +
    "(e.g. 'Acme Holding AG' vs 'Acme').",
  scope: "read:customers",
  queryParams: QueryParamsSchema,
  response: MatchResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: matchCustomersOp.scope });
    const query = matchCustomersOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );
    const limit = Math.min(
      query.limit ? Number.parseInt(query.limit, 10) : 5,
      20,
    );

    const rows = await matchCustomersByName(query.q, limit);

    const body = matchCustomersOp.response.parse({
      items: rows,
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_match_customers",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: matchCustomersOp.path,
      result_count: body.count,
    });

    return body;
  });
}
