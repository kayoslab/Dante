/** Singleton OpenAPI registry for `/api/agent/*`.
 *
 * Every endpoint registers itself here at module load via
 * `defineAgentOp`. The `/api/agent/openapi.json` route iterates the
 * registry to produce the spec — there's no separate codegen step.
 *
 * Side-effect imports in `lib/agent/operations/index.ts` ensure the
 * registry is populated regardless of which route Next.js happens to
 * load first. */
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

import { AGENT_SCOPES, type AgentScope } from "@/lib/auth/agent-scopes";

// Adds `.openapi(...)` to every Zod schema so endpoint authors can
// annotate types inline (`z.string().openapi({ example: 'foo' })`).
extendZodWithOpenApi(z);

export const agentRegistry = new OpenAPIRegistry();

// Cognito OAuth security scheme. The fully-qualified scope strings
// (`dante-agents/<name>`) come from the catalog so adding a scope is
// one source-of-truth edit, not three.
const COGNITO_BASE = "https://auth.dante.example.com";
const RESOURCE_SERVER = "dante-agents";

const scopeMap: Record<string, string> = {};
for (const [scope, def] of Object.entries(AGENT_SCOPES) as Array<
  [AgentScope, (typeof AGENT_SCOPES)[AgentScope]]
>) {
  scopeMap[`${RESOURCE_SERVER}/${scope}`] = def.description;
}

agentRegistry.registerComponent("securitySchemes", "cognito", {
  type: "oauth2",
  description:
    "Cognito-issued bearer token from the dante-agents resource " +
    "server. Obtain via Authorization Code flow with PKCE against " +
    "the agent app client.",
  flows: {
    authorizationCode: {
      authorizationUrl: `${COGNITO_BASE}/oauth2/authorize`,
      tokenUrl: `${COGNITO_BASE}/oauth2/token`,
      scopes: scopeMap,
    },
  },
});

// Reusable error envelope. Every operation returns this shape on
// non-200 — registering once + referencing via `$ref` keeps the spec
// concise.
export const ErrorEnvelopeSchema = z
  .object({
    detail: z.string(),
    code: z.enum([
      "internal_error",
      "not_found",
      "conflict",
      "validation_error",
      "unauthorized",
      "forbidden",
      "rate_limited",
    ]),
  })
  .openapi("ErrorEnvelope");

agentRegistry.register("ErrorEnvelope", ErrorEnvelopeSchema);
