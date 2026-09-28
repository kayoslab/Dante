/** OpenAPI 3.1 document for the agent endpoints.
 *
 * Generated from the per-operation Zod schemas registered via
 * `defineAgentOp`. The side-effect import below loads every route
 * file so the registry is populated regardless of which route
 * Next.js cold-starts first.
 *
 * Why 3.1 and not 3.0: agent runtimes (EVE → Anthropic) consume the
 * schemas as JSON Schema draft 2020-12. OpenAPI 3.0 emits 3.0-flavored
 * keywords that aren't valid JSON Schema:
 *   - `nullable: true` is illegal in 2020-12; use `type: ["x","null"]`.
 *   - `exclusiveMinimum: true` (boolean) is illegal; the value itself
 *     belongs there as a number.
 * Optional+nullable Zod fields trip both of these. OpenAPI 3.1 uses
 * JSON Schema 2020-12 natively, so `zod-to-openapi`'s OpenApiGeneratorV31
 * emits a spec that EVE can forward to Anthropic without rewriting.
 *
 * Cache headers: this document only changes on deploy, so a 1-hour
 * shared-cache TTL keeps the upstream representation hot. EVE
 * Connections refetch on agent boot — bouncing the agent after a
 * Dante deploy is the safest way to pick up newly-added operations
 * before the cache TTL elapses. */
import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { NextResponse, type NextRequest } from "next/server";

import "@/lib/agent/operations";

import { agentRegistry } from "@/lib/agent/openapi-registry";

export async function GET(req: NextRequest) {
  const generator = new OpenApiGeneratorV31(agentRegistry.definitions);
  const document = generator.generateDocument({
    openapi: "3.1.0",
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
        // Canonical public origin (NEXTAUTH_URL in prod); fall back to
        // whatever origin served this document so dev / preview hosts
        // get a working server URL too.
        url: `${process.env.NEXTAUTH_URL ?? req.nextUrl.origin}/api/agent`,
        description: "This deployment",
      },
    ],
  });

  return NextResponse.json(document, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=3600",
    },
  });
}
