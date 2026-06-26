/** OpenAPI 3.0 document for the agent endpoints.
 *
 * Generated from the per-operation Zod schemas registered via
 * `defineAgentOp`. The side-effect import below loads every route
 * file so the registry is populated regardless of which route
 * Next.js cold-starts first.
 *
 * Cache headers: this document only changes on deploy, so a 1-hour
 * shared-cache TTL keeps the upstream representation hot. EVE
 * Connections refetch on agent boot — bouncing the agent after a
 * Dante deploy is the safest way to pick up newly-added operations
 * before the cache TTL elapses. */
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { NextResponse } from "next/server";

import "@/lib/agent/operations";

import { agentRegistry } from "@/lib/agent/openapi-registry";

export async function GET() {
  const generator = new OpenApiGeneratorV3(agentRegistry.definitions);
  const document = generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Dante Agent API",
      description:
        "Read-only project, customer, and rentability data exposed " +
        "to agents via OAuth-authenticated bearer tokens. Each " +
        "operation requires the corresponding `dante-agents/*` " +
        "scope on the access token; missing scopes return 401. The " +
        "Pre Token Generation Lambda subsets requested scopes " +
        "against the user's Cognito group at issuance time, so a " +
        "consent screen offering all five scopes still issues only " +
        "the ones the user's role permits.",
      version: "1.0.0",
    },
    servers: [
      {
        url: "https://dante.example.com/api/agent",
        description: "Production",
      },
    ],
  });

  return NextResponse.json(document, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=3600",
    },
  });
}
