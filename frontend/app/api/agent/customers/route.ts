/** Slim list of all customers + create-customer write endpoint. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { Conflict, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { listCustomers } from "@/lib/db/queries/customer-list";
import {
  findCustomerIdByName,
  insertCustomer,
} from "@/lib/db/queries/customer";
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

// ---------------------------------------------------------------------------
// createCustomer — POST /api/agent/customers
// ---------------------------------------------------------------------------

const CreateCustomerBodySchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .openapi({
        example: "Acme Holding AG",
        description:
          "Full customer name as it should appear in Dante. Use the " +
          "legal entity when possible (`Acme Holding AG`, not `Acme`).",
      }),
    notes: z
      .string()
      .trim()
      .max(2_000)
      .nullable()
      .optional()
      .openapi({
        example: "Created from framework agreement PDF, 2026-06-27.",
        description:
          "Optional free-text annotation — provenance, contact, or " +
          "anything the next operator should know.",
      }),
  })
  .openapi("AgentCreateCustomerRequest");

const CreateCustomerResponseSchema = z
  .object({
    customer_id: z.number().int().openapi({ example: 42 }),
    name: z.string().openapi({ example: "Acme Holding AG" }),
  })
  .openapi("AgentCreateCustomerResponse");

export const createCustomerOp = defineAgentOp({
  method: "post",
  path: "/customers",
  operationId: "createCustomer",
  summary: "Create a customer.",
  description:
    "Create a brand-new customer. The name must not already exist " +
    "(case-insensitive) — when ingesting a PDF, ALWAYS call " +
    "`matchCustomers` first to discover similar existing names and " +
    "prompt the user to pick one before falling back to create. " +
    "Manager + admin scope; every call parks for explicit user " +
    "confirmation in the chat (HITL approval gate on the EVE side).",
  scope: "write:customers",
  body: CreateCustomerBodySchema,
  response: CreateCustomerResponseSchema,
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: createCustomerOp.scope,
    });
    const raw = await req.json().catch(() => null);
    const input = createCustomerOp.parseBody(raw);

    const existing = await findCustomerIdByName(input.name);
    if (existing !== null) {
      throw Conflict(
        `Customer "${input.name}" already exists (customer_id ${existing}).`,
      );
    }

    const customer_id = await insertCustomer({
      name: input.name,
      notes: input.notes ?? null,
    });

    const body = createCustomerOp.response.parse({
      customer_id,
      name: input.name,
    });

    await audit(ctx, {
      action: "agent_create_customer",
      target_type: "customer",
      target_id: customer_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: createCustomerOp.path,
      method: "POST",
      customer_id,
    });

    return body;
  });
}
