/** Framework agreement write endpoint.
 *
 * Wraps `insertFramework` + optional `insertFrameworkRate[]` from
 * `lib/db/queries/framework.ts`. Same role gate as
 * `createFrameworkAction` on the web (manager+). The EVE-side
 * connection adds an approval policy on top so every call parks the
 * run for explicit confirmation — defense in depth: scope grants the
 * capability; HITL gates each invocation. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { IsoDateString } from "@/lib/agent/_validation";
import { Conflict, NotFound, Validation, handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { customerExists } from "@/lib/db/queries/customer";
import {
  findFrameworkByCustomerAndName,
  insertFramework,
  insertFrameworkRate,
} from "@/lib/db/queries/framework";
import { log } from "@/lib/logger";

const FrameworkRateInputSchema = z
  .object({
    profile: z.string().trim().min(1).max(100).openapi({
      example: "Senior DevOps Consultant / Technischer Projektleiter",
      description:
        "Role / profile label. Up to 100 chars — fits the compound " +
        "German consulting titles that show up on real rate cards.",
    }),
    valid_from: IsoDateString.openapi({ example: "2026-07-01" }),
    daily_rate_eur: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/)
      .openapi({
        example: "1200.00",
        description: "Daily rate in EUR as a decimal string.",
      }),
  })
  .openapi("AgentFrameworkRateInput");

const CreateFrameworkBodySchema = z
  .object({
    customer_id: z
      .number()
      .int()
      .positive()
      .openapi({
        example: 7,
        description: "Existing customer. Get from `matchCustomers` first.",
      }),
    name: z.string().trim().min(1).max(200).openapi({
      example: "Acme Framework 2026–2028",
    }),
    start_date: IsoDateString
      .nullable()
      .optional()
      .openapi({ example: "2026-07-01" }),
    end_date: IsoDateString
      .nullable()
      .optional()
      .openapi({ example: "2028-06-30" }),
    notes: z.string().trim().max(2_000).nullable().optional(),
    rates: z
      .array(FrameworkRateInputSchema)
      .max(50)
      .optional()
      .openapi({
        description:
          "Per-profile rate cards to insert alongside the framework. " +
          "Projects under this framework inherit these by default.",
      }),
  })
  .openapi("AgentCreateFrameworkRequest");

const CreateFrameworkResponseSchema = z
  .object({
    framework_id: z.number().int().openapi({ example: 12 }),
    name: z.string(),
    customer_id: z.number().int(),
    rates_inserted: z.number().int(),
  })
  .openapi("AgentCreateFrameworkResponse");

export const createFrameworkOp = defineAgentOp({
  method: "post",
  path: "/frameworks",
  operationId: "createFramework",
  summary: "Create a framework agreement.",
  description:
    "Create a framework agreement for an existing customer, optionally " +
    "with its rate card. The (customer_id, name) pair must be unique. " +
    "Manager + admin scope; parks the run for explicit confirmation.",
  scope: "write:frameworks",
  body: CreateFrameworkBodySchema,
  response: CreateFrameworkResponseSchema,
});

export async function POST(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, {
      scope: createFrameworkOp.scope,
    });
    const raw = await req.json().catch(() => null);
    const input = createFrameworkOp.parseBody(raw);

    if (input.start_date && input.end_date && input.end_date < input.start_date) {
      throw Validation(
        `end_date ${input.end_date} is before start_date ${input.start_date}.`,
      );
    }
    if (!(await customerExists(input.customer_id))) {
      throw NotFound(`Customer ${input.customer_id} does not exist.`);
    }
    const existing = await findFrameworkByCustomerAndName(
      input.customer_id,
      input.name,
    );
    if (existing !== null) {
      throw Conflict(
        `Framework "${input.name}" already exists for customer ${input.customer_id} (framework_id ${existing}).`,
      );
    }

    const framework_id = await insertFramework({
      customer_id: input.customer_id,
      name: input.name,
      start_date: input.start_date ?? null,
      end_date: input.end_date ?? null,
      notes: input.notes ?? null,
    });

    let ratesInserted = 0;
    if (input.rates && input.rates.length > 0) {
      for (const r of input.rates) {
        await insertFrameworkRate({
          framework_id,
          profile: r.profile,
          valid_from: r.valid_from,
          daily_rate_eur: r.daily_rate_eur,
        });
        ratesInserted++;
      }
    }

    const body = createFrameworkOp.response.parse({
      framework_id,
      name: input.name,
      customer_id: input.customer_id,
      rates_inserted: ratesInserted,
    });

    await audit(ctx, {
      action: "agent_create_framework",
      target_type: "framework",
      target_id: framework_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: createFrameworkOp.path,
      method: "POST",
      framework_id,
      rates_inserted: ratesInserted,
    });

    return body;
  });
}
