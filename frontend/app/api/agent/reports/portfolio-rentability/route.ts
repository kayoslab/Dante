/** Portfolio-wide P&L rollup for a single month. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { computePortfolioMonthlyTotals } from "@/lib/db/queries/portfolio";
import { log } from "@/lib/logger";

const QuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .openapi({ example: "2026-06" }),
});

const PortfolioRentabilitySchema = z
  .object({
    month: z.string(),
    revenue: z.string().openapi({
      description:
        "Top-line revenue across every active project. T&M contributes " +
        "tracked × rate; FP contributes recognized revenue for the month.",
    }),
    cost: z.string().openapi({
      description: "Loaded payroll cost across every project-contributing employee.",
    }),
    margin: z.string(),
    margin_pct: z.string().nullable(),
  })
  .openapi("AgentPortfolioRentability");

export const getPortfolioRentabilityOp = defineAgentOp({
  method: "get",
  path: "/reports/portfolio-rentability",
  operationId: "getPortfolioRentability",
  summary: "Portfolio P&L for one month.",
  description:
    "Top-line revenue, cost, and margin for the entire active project " +
    "portfolio in a given month. Use to answer 'how profitable is the " +
    "company this month?' or to track the rentability trend.",
  scope: "read:reports",
  queryParams: QuerySchema,
  response: PortfolioRentabilitySchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: getPortfolioRentabilityOp.scope,
    });
    const queryParsed = getPortfolioRentabilityOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    const totals = await computePortfolioMonthlyTotals(queryParsed.month);
    const body = getPortfolioRentabilityOp.response.parse(totals);

    await audit(ctx, {
      action: "agent_get_portfolio_rentability",
      target_type: "month",
      target_id: queryParsed.month,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: getPortfolioRentabilityOp.path,
      month: queryParsed.month,
    });

    return body;
  });
}
