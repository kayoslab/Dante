/** POC agent endpoint: a slim, LLM-friendly list of active projects.
 *
 * Authenticated by a Cognito access token from the agent app client
 * (carrying scope `dante-agents/read:projects`). No session cookie.
 * The response shape is deliberately a strict subset of
 * `PortfolioProjectRow` — agents don't need every monthly breakdown
 * field, and the smaller surface keeps prompt-context cost down on
 * the LLM side.
 *
 * One audit row per call (`agent_view_projects`) plus a structured
 * `agent_invoke` log line carrying the Cognito client_id + sub for
 * CloudWatch detection rules. */
import type { NextRequest } from "next/server";

import { handle } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";
import { requireAgentSession } from "@/lib/auth/agent-jwt";
import { audit } from "@/lib/auth/audit";
import { listActiveProjectsForPortfolio } from "@/lib/db/queries/project-monthly";
import { log } from "@/lib/logger";

/** Slim agent-facing shape. Snake-case keys match the rest of the API
 * so consumer types can be generated alongside the existing ones. */
export type AgentProjectListItem = {
  project_id: number;
  name: string;
  billing_model: "fixed_price" | "time_and_material";
  customer_id: number;
  customer_name: string;
};

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireAgentSession(req, { scope: "read:projects" });
    enforceRateLimit(ctx, "agent_projects", "normal");

    const rows = await listActiveProjectsForPortfolio();
    const items: AgentProjectListItem[] = rows.map((r) => ({
      project_id: r.project_id,
      name: r.name,
      billing_model:
        r.billing_model === "fixed_price" ? "fixed_price" : "time_and_material",
      customer_id: r.customer_id,
      customer_name: r.customer_name,
    }));

    // Audit + structured log. The audit row goes to the DB (long-term
    // forensic trail); the log line goes to CloudWatch (real-time
    // detection — metric filters can alarm on rate spikes per token).
    await audit(ctx, {
      action: "agent_view_projects",
      target_type: "agent_client",
      target_id: ctx.client_id,
    });
    log.info("agent_invoke", {
      user_id: ctx.user_id,
      cognito_sub: ctx.cognito_sub,
      client_id: ctx.client_id,
      endpoint: "/api/agent/projects",
      result_count: items.length,
    });

    return { items, count: items.length };
  });
}
