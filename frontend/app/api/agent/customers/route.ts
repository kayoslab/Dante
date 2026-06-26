/** Slim list of all customers. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { listCustomers } from "@/lib/db/queries/customer-list";
import { log } from "@/lib/logger";

const CustomerListItemSchema = z
  .object({
    customer_id: z.number().int().openapi({ example: 7 }),
    name: z.string().openapi({ example: "Acme Holding AG" }),
    n_frameworks: z.number().int(),
    n_projects: z.number().int(),
  })
  .openapi("AgentCustomerListItem");

const ListCustomersResponseSchema = z.object({
  items: z.array(CustomerListItemSchema),
  count: z.number().int(),
});

export const listCustomersOp = defineAgentOp({
  method: "get",
  path: "/customers",
  operationId: "listCustomers",
  summary: "List customers.",
  description:
    "Every customer with their framework + project counts. Sorted by " +
    "name. Use to discover customer_ids before drilling into " +
    "`getCustomerRentability` or per-project endpoints.",
  scope: "read:customers",
  response: ListCustomersResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: listCustomersOp.scope });
    const rows = await listCustomers({ sort: "name", order: "asc" });
    const body = listCustomersOp.response.parse({
      items: rows,
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_list_customers",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: listCustomersOp.path,
      result_count: body.count,
    });

    return body;
  });
}
