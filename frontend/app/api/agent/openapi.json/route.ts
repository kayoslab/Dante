/** OpenAPI 3.0 spec for the `/api/agent/*` endpoints.
 *
 * Vercel EVE (or any OpenAPI-aware agent runtime) fetches this at
 * runtime via `defineOpenAPIConnection({ spec: "<this URL>" })` and
 * materializes one tool per operation. Tool descriptions come from
 * `summary` + `description`; the `x-scope` extension on each
 * operation hints to operators which Cognito scope the agent needs
 * to grant.
 *
 * Public endpoint — the spec is descriptive (no secrets in the
 * document itself). Authentication still required to call the
 * underlying operations via a Cognito access token.
 *
 * As we add agent endpoints, append operations here. Once we hit
 * five or so, swap to a Zod → OpenAPI generator (`@hono/zod-openapi`
 * or `zod-to-openapi`) and have each route export its own Zod
 * input/output schemas; the spec becomes a build-time aggregation. */
import { NextResponse } from "next/server";

const SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Dante Agent API",
    description:
      "Read-only project, customer, and rentability data exposed to " +
      "agents via OAuth-authenticated bearer tokens. Each operation " +
      "requires the corresponding `dante-agents/*` scope on the access " +
      "token; missing scopes return 401.",
    version: "1.0.0",
  },
  servers: [
    {
      url: "https://dante.example.com/api/agent",
      description: "Production",
    },
  ],
  components: {
    securitySchemes: {
      cognito: {
        type: "oauth2",
        description:
          "Cognito-issued bearer token from the dante-agents resource " +
          "server. Obtain via Authorization Code flow with PKCE against " +
          "the agent app client.",
        flows: {
          authorizationCode: {
            authorizationUrl:
              "https://auth.dante.example.com/oauth2/authorize",
            tokenUrl: "https://auth.dante.example.com/oauth2/token",
            scopes: {
              "dante-agents/read:projects":
                "List projects + per-project monthly P&L.",
              "dante-agents/read:customers":
                "List customers + their frameworks + rates.",
              "dante-agents/read:reports":
                "Portfolio + customer rentability rollups.",
              "dante-agents/read:employees":
                "List employees, teams, role tiers.",
              "dante-agents/read:salaries":
                "Per-employee salary history + monthly cost.",
            },
          },
        },
      },
    },
    schemas: {
      AgentProjectListItem: {
        type: "object",
        required: ["project_id", "name", "billing_model", "customer_id", "customer_name"],
        properties: {
          project_id: { type: "integer", example: 42 },
          name: { type: "string", example: "Acme: Capacity Study" },
          billing_model: {
            type: "string",
            enum: ["fixed_price", "time_and_material"],
          },
          customer_id: { type: "integer", example: 7 },
          customer_name: { type: "string", example: "Acme Holding AG" },
        },
      },
      ErrorEnvelope: {
        type: "object",
        required: ["detail", "code"],
        properties: {
          detail: { type: "string" },
          code: {
            type: "string",
            enum: [
              "internal_error",
              "not_found",
              "conflict",
              "validation_error",
              "unauthorized",
              "forbidden",
              "rate_limited",
            ],
          },
        },
      },
    },
  },
  paths: {
    "/projects": {
      get: {
        operationId: "listProjects",
        summary: "List active projects.",
        description:
          "Returns every active project the caller's role can see, in a " +
          "slim shape: project_id, name, billing model, customer. Use " +
          "this to discover what's in the portfolio before drilling into " +
          "per-project monthly P&L (future endpoint).",
        "x-scope": "dante-agents/read:projects",
        security: [{ cognito: ["dante-agents/read:projects"] }],
        responses: {
          "200": {
            description: "Active projects.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["items", "count"],
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/AgentProjectListItem",
                      },
                    },
                    count: { type: "integer" },
                  },
                },
              },
            },
          },
          "401": {
            description: "Missing or invalid Cognito access token.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ErrorEnvelope" },
              },
            },
          },
        },
      },
    },
  },
} as const;

export async function GET() {
  // Cached aggressively at the edge — the spec only changes on
  // deploy. `s-maxage` keeps the upstream representation hot for an
  // hour; CDN-level cache key honors the URL.
  return NextResponse.json(SPEC, {
    headers: {
      "Cache-Control": "public, max-age=60, s-maxage=3600",
    },
  });
}
