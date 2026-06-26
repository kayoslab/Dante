/** Per-customer P&L rollup for a single month. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { computeCustomerMonthlyAggregates } from "@/lib/db/queries/customer-rentability";
import { log } from "@/lib/logger";

const QuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .openapi({ example: "2026-06" }),
});

const CustomerAggregateSchema = z
  .object({
    customer_id: z.number().int(),
    customer_name: z.string(),
    n_projects: z.number().int(),
    revenue: z.string(),
    cost: z.string(),
    margin: z.string(),
    margin_pct: z.string().nullable(),
  })
  .openapi("AgentCustomerRentabilityRow");

const CustomerRentabilityResponseSchema = z.object({
  month: z.string(),
  items: z.array(CustomerAggregateSchema),
  count: z.number().int(),
});

export const getCustomerRentabilityOp = defineAgentOp({
  method: "get",
  path: "/reports/customer-rentability",
  operationId: "getCustomerRentability",
  summary: "Per-customer rentability for one month.",
  description:
    "Revenue, cost, and margin rolled up by customer for the given " +
    "month. Useful for ranking customers by profitability or surfacing " +
    "customers running at a loss.",
  scope: "read:reports",
  queryParams: QuerySchema,
  response: CustomerRentabilityResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: getCustomerRentabilityOp.scope,
    });
    const queryParsed = getCustomerRentabilityOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    const rows = await computeCustomerMonthlyAggregates(queryParsed.month);
    const body = getCustomerRentabilityOp.response.parse({
      month: queryParsed.month,
      items: rows,
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_get_customer_rentability",
      target_type: "month",
      target_id: queryParsed.month,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: getCustomerRentabilityOp.path,
      month: queryParsed.month,
      result_count: body.count,
    });

    return body;
  });
}
