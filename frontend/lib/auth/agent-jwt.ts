/** Cognito access-token validation for `/api/agent/*` routes.
 *
 * Replaces the (briefly-prototyped) Dante-native PAT path: identity is
 * managed by Cognito end-to-end. An agent (Vercel EVE etc.) completes
 * the OAuth Authorization Code flow against the agent app client,
 * receives a JWT access token, and presents it on every API call.
 * We validate the token against the user pool's JWKS, narrow the
 * scope claim against this route's required scope, and attribute the
 * call to the local app_user row.
 *
 * Failure modes are conflated to one 401 with no detail (no token,
 * bad signature, wrong audience, missing scope, unknown user, expired,
 * etc.). The legitimate caller has the agent's OAuth error path —
 * Dante never knows whether a token was "almost valid" or random
 * bytes.
 *
 * JWKS caching: `createRemoteJWKSet` returns a function backed by a
 * 10-minute in-process cache. RS256 key rotation in Cognito drops a
 * new entry in the JWKS — the next miss refetches. For a 40-user app
 * with two app tasks, this is fine; no Redis needed. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NextRequest } from "next/server";

import { Unauthorized } from "@/lib/api/_route-helpers";
import { checkRateLimit, enforceGlobalApiRateLimit, RATE_LIMITS } from "@/lib/api/rate-limit";
import { findAppUserByCognitoSub } from "@/lib/db/queries/app-user";
import { isUserDisabled, ROLE_RANK, type SessionContext } from "@/lib/auth/session";

import {
  AGENT_SCOPES,
  parseAgentScope,
  type AgentScope,
} from "./agent-scopes";

const BEARER_PREFIX = "Bearer ";

/** `dante-agents` from the cognito module's Resource Server identifier.
 * Scopes are issued in the form `dante-agents/<name>` — we strip the
 * prefix before matching against the catalog. */
const RESOURCE_SERVER_PREFIX = "dante-agents/";

export type AgentSessionContext = SessionContext & {
  kind: "agent";
  cognito_sub: string;
  client_id: string;
  scopes: AgentScope[];
};

/** Lazy singleton — instantiated on first use so a missing env var
 * surfaces as a route-level Unauthorized rather than a module-load
 * crash that kills the whole worker. */
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** sub → app_user cache. Same 30s TTL the disabled-user cache uses,
 * keyed on Cognito sub. Saves a DB round-trip on every agent call
 * for the (common) case where the same user makes many requests
 * inside a single 30s window. Cache invalidates implicitly by TTL —
 * we don't try to push-invalidate, because the next miss within 30s
 * just refetches and any change shows up automatically. */
const SUB_TO_OWNER_TTL_MS = 30_000;
type CachedOwner = {
  owner: { user_id: string; email: string; role: "admin" | "manager" | "employee"; employee_id: number | null };
  expires_at: number;
};
const subOwnerCache = new Map<string, CachedOwner>();
async function lookupOwnerCached(sub: string) {
  const now = Date.now();
  const cached = subOwnerCache.get(sub);
  if (cached && cached.expires_at > now) return cached.owner;
  const owner = await findAppUserByCognitoSub(sub);
  if (owner) {
    subOwnerCache.set(sub, { owner, expires_at: now + SUB_TO_OWNER_TTL_MS });
  }
  return owner;
}

function getJwks() {
  if (cachedJwks) return cachedJwks;
  const issuer = process.env.COGNITO_ISSUER;
  if (!issuer) {
    throw new Error(
      "COGNITO_ISSUER is not set. The agent JWT validator needs it to " +
        "locate the JWKS endpoint. Confirm the ECS task env wiring.",
    );
  }
  cachedJwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  return cachedJwks;
}

/** Verify a Cognito access token and return the agent session context.
 * Caller passes the scope this route requires — the token must carry
 * `dante-agents/<scope>` to be accepted. */
export async function requireAgentSession(
  req: NextRequest,
  opts: { scope: AgentScope },
): Promise<AgentSessionContext> {
  const header = req.headers.get("authorization");
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    throw Unauthorized();
  }
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token === "") {
    throw Unauthorized();
  }

  const issuer = process.env.COGNITO_ISSUER;
  const agent_client_id = process.env.COGNITO_AGENT_CLIENT_ID;
  if (!issuer || !agent_client_id) {
    // Misconfiguration — log loudly server-side, return opaque 401.
    // Don't leak the env-var name to the caller.
    // eslint-disable-next-line no-console
    console.error("agent-jwt: COGNITO_ISSUER or COGNITO_AGENT_CLIENT_ID missing");
    throw Unauthorized();
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getJwks(), {
      issuer,
      // Cognito access tokens carry the client_id in the `client_id`
      // claim, not `aud` (Cognito doesn't set `aud` on access tokens).
      // We verify against the claim manually below. The issuer + signature
      // verification jose does here is what gets us out of "anyone with
      // a JWT signed by a different IdP" territory.
    });
    payload = verified.payload;
  } catch {
    throw Unauthorized();
  }

  // token_use === "access" — Cognito also issues ID tokens for the
  // openid scope; those have a different signing key and audience
  // shape. Reject ID tokens explicitly so a caller can't substitute
  // one and skirt the scope check.
  if (payload.token_use !== "access") {
    throw Unauthorized();
  }
  if (payload.client_id !== agent_client_id) {
    // A token from the web app client must NOT work here — the web
    // client doesn't request dante-agents scopes, but defense in
    // depth: we want a different scope claim shape, not "user happens
    // to have the right scope by accident".
    throw Unauthorized();
  }

  // Parse + filter scopes against the requested one.
  const scopes_in_token = parseScopeClaim(payload.scope);
  if (!scopes_in_token.includes(opts.scope)) {
    throw Unauthorized();
  }

  // Map Cognito sub → app_user row for audit attribution.
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  if (!sub) {
    throw Unauthorized();
  }
  const owner = await lookupOwnerCached(sub);
  if (!owner) {
    throw Unauthorized();
  }

  // Defense in depth: re-check that the user's role permits the
  // requested scope, ignoring whatever the token actually carries.
  // The Pre Token Generation Lambda is supposed to filter scopes at
  // issuance time, but a bug there (or a future change that widens
  // the group → scope map by accident) would otherwise become a
  // silent privilege escalation. We trust the role, not the token's
  // own scope claim.
  const scope_def = AGENT_SCOPES[opts.scope];
  if (!scope_def) {
    throw Unauthorized();
  }
  if (ROLE_RANK[owner.role] < ROLE_RANK[scope_def.min_role]) {
    throw Unauthorized();
  }

  // Owner-disabled check — same 30s cache requireSession shares.
  // Cognito disabling a user also flips app_user.is_disabled in the
  // sign-in callback path; this catches between-sign-in revocations
  // too because the cache reads from the DB column directly.
  if (await isUserDisabled(owner.user_id)) {
    throw Unauthorized();
  }

  const ctx: AgentSessionContext = {
    user_id: owner.user_id,
    email: owner.email,
    role: owner.role,
    employee_id: owner.employee_id,
    kind: "agent",
    cognito_sub: sub,
    client_id: agent_client_id,
    scopes: scopes_in_token,
  };

  // Per-user global ceiling — shared with the web session bucket so
  // a runaway agent ALSO trips this and gets cut off at the per-user
  // safety net. But the global is too loose to act as the agent's
  // primary limit (600/min); add a per-client tighter bucket so a
  // misbehaving agent can't starve the human's web budget. Keyed
  // on (user_id, client_id) so two different agent clients for the
  // same user get separate buckets.
  enforceGlobalApiRateLimit(ctx);
  checkRateLimit(ctx.user_id, `agent:${ctx.client_id}`, RATE_LIMITS.normal);

  return ctx;
}

/** Cognito puts scopes in the `scope` claim as a space-separated
 * string. We drop the `dante-agents/` prefix and only return scopes
 * the local catalog recognizes; unknown scopes (e.g. `openid`) are
 * silently filtered. */
function parseScopeClaim(raw: unknown): AgentScope[] {
  if (typeof raw !== "string") return [];
  const out: AgentScope[] = [];
  for (const piece of raw.split(/\s+/)) {
    if (!piece.startsWith(RESOURCE_SERVER_PREFIX)) continue;
    const name = piece.slice(RESOURCE_SERVER_PREFIX.length);
    const parsed = parseAgentScope(name);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}
