/** `defineAgentOp` — single source of truth for an `/api/agent/*`
 * operation. One call registers the operation on the OpenAPI
 * registry AND returns typed schemas the route handler uses.
 *
 * The registry-side and the handler-side share the SAME Zod schemas,
 * so the spec the agent fetches can never drift from the actual
 * request/response shape — change the schema, both surfaces update.
 *
 * Typical usage from a route file:
 *
 *   export const listProjectsOp = defineAgentOp({
 *     method: "get",
 *     path: "/projects",
 *     operationId: "listProjects",
 *     summary: "List active projects.",
 *     description: "...",
 *     scope: "read:projects",
 *     response: z.object({ items: z.array(ProjectSchema), count: z.number() }),
 *   });
 *
 *   export async function GET(req: NextRequest) {
 *     return handle(async () => {
 *       const ctx = await requireAgentSession(req, { scope: listProjectsOp.scope });
 *       ...
 *       return listProjectsOp.response.parse({ items, count });
 *     });
 *   }
 */
import type { ZodObject, ZodRawShape, ZodTypeAny, z } from "zod";

import type { AgentScope } from "@/lib/auth/agent-scopes";

import { agentRegistry, ErrorEnvelopeSchema } from "./openapi-registry";

export type AgentOpMethod = "get" | "post" | "put" | "delete";

export type AgentOpDef<
  PathParams extends ZodObject<ZodRawShape> | undefined,
  QueryParams extends ZodObject<ZodRawShape> | undefined,
  Response extends ZodTypeAny,
> = {
  method: AgentOpMethod;
  /** Path relative to `/api/agent`, with `{param}` placeholders. */
  path: string;
  /** Used as the tool name on the EVE side: `dante__<operationId>`. */
  operationId: string;
  /** Short label the model sees in the tool list. */
  summary: string;
  /** Longer hint — when to use the tool, scope reminders, gotchas. */
  description: string;
  /** Required Cognito scope. The route's `requireAgentSession` call
   * passes this verbatim. */
  scope: AgentScope;
  pathParams?: PathParams;
  queryParams?: QueryParams;
  response: Response;
};

/** Strongly-typed return so the route handler keeps inference. */
export type AgentOp<
  PathParams extends ZodObject<ZodRawShape> | undefined,
  QueryParams extends ZodObject<ZodRawShape> | undefined,
  Response extends ZodTypeAny,
> = AgentOpDef<PathParams, QueryParams, Response> & {
  /** Inferred from `pathParams`; undefined when not declared. */
  parsePath: PathParams extends ZodTypeAny
    ? (raw: unknown) => z.infer<NonNullable<PathParams>>
    : undefined;
  /** Inferred from `queryParams`; undefined when not declared. */
  parseQuery: QueryParams extends ZodTypeAny
    ? (raw: unknown) => z.infer<QueryParams>
    : undefined;
};

export function defineAgentOp<
  PathParams extends ZodObject<ZodRawShape> | undefined,
  QueryParams extends ZodObject<ZodRawShape> | undefined,
  Response extends ZodTypeAny,
>(
  def: AgentOpDef<PathParams, QueryParams, Response>,
): AgentOp<PathParams, QueryParams, Response> {
  // Register the path against the OpenAPI document. Security points
  // at the Cognito scheme defined in `openapi-registry.ts`; the
  // scope set is just this operation's required scope.
  agentRegistry.registerPath({
    method: def.method,
    path: def.path,
    operationId: def.operationId,
    summary: def.summary,
    description: def.description,
    security: [{ cognito: [`dante-agents/${def.scope}`] }],
    request: {
      ...(def.pathParams ? { params: def.pathParams } : {}),
      ...(def.queryParams ? { query: def.queryParams } : {}),
    },
    responses: {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: def.response },
        },
      },
      401: {
        description:
          "Missing or invalid Cognito access token, missing scope, " +
          "user disabled, or role below the scope's minimum.",
        content: {
          "application/json": { schema: ErrorEnvelopeSchema },
        },
      },
      429: {
        description: "Per-user or per-client rate limit exceeded.",
        content: {
          "application/json": { schema: ErrorEnvelopeSchema },
        },
      },
    },
  });

  return {
    ...def,
    parsePath: (def.pathParams
      ? (raw: unknown) => def.pathParams!.parse(raw)
      : undefined) as AgentOp<PathParams, QueryParams, Response>["parsePath"],
    parseQuery: (def.queryParams
      ? (raw: unknown) => def.queryParams!.parse(raw)
      : undefined) as AgentOp<PathParams, QueryParams, Response>["parseQuery"],
  };
}
