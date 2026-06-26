/** Slim list of active employees — no salary, no personal data
 * beyond identity + team. */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { defineAgentOp } from "@/lib/agent/operation";
import { handle } from "@/lib/api/_route-helpers";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { listEmployees } from "@/lib/db/queries/employee-list";
import { log } from "@/lib/logger";

const QuerySchema = z.object({
  q: z.string().optional().openapi({
    description: "Free-text search across first/last name + email.",
  }),
  team: z.string().optional(),
});

const EmployeeListItemSchema = z
  .object({
    employee_id: z.number().int(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    team: z.string().nullable(),
    role_tier: z.string().nullable(),
    position: z.string().nullable(),
    fte: z.number().nullable(),
    contract_end_date: z.string().nullable(),
  })
  .openapi("AgentEmployeeListItem");

const ListEmployeesResponseSchema = z.object({
  items: z.array(EmployeeListItemSchema),
  count: z.number().int(),
});

export const listEmployeesOp = defineAgentOp({
  method: "get",
  path: "/employees",
  operationId: "listEmployees",
  summary: "List active employees.",
  description:
    "Active project-contributing employees (slim shape, no salary, no " +
    "Personio personal data). Use to find employee_ids before drilling " +
    "into `getEmployeeMonthly`.",
  scope: "read:employees",
  queryParams: QuerySchema,
  response: ListEmployeesResponseSchema,
});

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: listEmployeesOp.scope });
    const queryParsed = listEmployeesOp.parseQuery!(
      Object.fromEntries(req.nextUrl.searchParams),
    );

    const rows = await listEmployees({
      q: queryParsed.q,
      team: queryParsed.team,
      status: "active",
      include_excluded: false,
    });
    const body = listEmployeesOp.response.parse({
      items: rows.map((r) => ({
        employee_id: r.employee_id,
        first_name: r.first_name,
        last_name: r.last_name,
        team: r.team,
        role_tier: r.role_tier,
        position: r.position,
        fte: r.fte,
        contract_end_date: r.contract_end_date,
      })),
      count: rows.length,
    });

    await audit(ctx, {
      action: "agent_list_employees",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: listEmployeesOp.path,
      result_count: body.count,
    });

    return body;
  });
}
