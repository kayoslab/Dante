/** Cognito Pre Token Generation V3 Lambda.
 *
 * Cognito calls this on every access/ID token issuance for the user
 * pool (including refresh). Our job is to narrow the issued `scope`
 * claim so an `employee`-group user who consented to all the
 * `dante-agents/*` scopes doesn't actually receive the manager-only
 * ones like `read:salaries` in the token.
 *
 * The Lambda is shared across web + agent flows. The web app client
 * doesn't request `dante-agents/*` scopes, so the suppression list is
 * always empty there — the trigger fires but returns no overrides.
 *
 * Logic:
 *   1. Read the user's `cognito:groups` claim. Cognito's V3 trigger
 *      passes this in `event.request.groupConfiguration.groupsToOverride`
 *      (the value the user is signing in WITH, not a configured
 *      override — confusing naming on AWS's side).
 *   2. Determine the highest-permission group the user belongs to.
 *   3. For each requested scope of the form `dante-agents/<name>`,
 *      check it against the group's allowed-scope set. Suppress
 *      anything not allowed.
 *
 * Updating the group → scope mapping needs a redeploy of this Lambda.
 * It's a tiny piece of code; the source of truth lives here so it's
 * reviewable as a single file rather than spread across IAM policies. */
import type {
  PreTokenGenerationV3TriggerEvent,
  PreTokenGenerationV3TriggerHandler,
} from "aws-lambda";

const RESOURCE_SERVER_PREFIX = "dante-agents/";

/** Group → set of `dante-agents/*` scope names that group's members
 * are allowed to receive. Names match the resource server `scope_name`
 * in the cognito module (NOT prefixed with `dante-agents/`). */
const GROUP_SCOPE_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  // admin + manager get the same read AND write scopes — same
  // permissions on the agent surface as they have on the web. The
  // EVE-side connection layer adds an additional approval gate so
  // every write parks the run for explicit user confirmation in the
  // chat; the scope grant just lets the token CARRY the write
  // capability at all.
  admin: new Set([
    "read:projects",
    "read:customers",
    "read:reports",
    "read:employees",
    "read:salaries",
    "write:customers",
    "write:frameworks",
    "write:projects",
    "write:allocations",
    "write:time_tracking",
    "write:freelancers",
  ]),
  manager: new Set([
    "read:projects",
    "read:customers",
    "read:reports",
    "read:employees",
    "read:salaries",
    "write:customers",
    "write:frameworks",
    "write:projects",
    "write:allocations",
    "write:time_tracking",
    "write:freelancers",
  ]),
  employee: new Set([
    "read:projects",
    "read:customers",
  ]),
};

export const handler: PreTokenGenerationV3TriggerHandler = async (event) => {
  const scopesToSuppress = computeScopesToSuppress(event);

  if (scopesToSuppress.length === 0) {
    // Returning the event unchanged is the documented no-op signal.
    return event;
  }

  // Structured log line so a CloudWatch metric filter can alarm on
  // "agent token issued with unexpected scope suppression" — useful
  // during early rollout to confirm the Lambda is firing.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "info",
      event: "pretoken_scope_suppression",
      user_sub: event.request.userAttributes.sub,
      client_id: event.callerContext.clientId,
      groups: event.request.groupConfiguration.groupsToOverride ?? [],
      scopes_requested: event.request.scopes ?? [],
      scopes_suppressed: scopesToSuppress,
    }),
  );

  event.response = {
    claimsAndScopeOverrideDetails: {
      accessTokenGeneration: {
        scopesToSuppress,
      },
    },
  };
  return event;
};

/** Pure function so it can be unit-tested without Lambda glue. */
export function computeScopesToSuppress(
  event: PreTokenGenerationV3TriggerEvent,
): string[] {
  const requested = event.request.scopes ?? [];
  if (requested.length === 0) return [];

  // Cognito puts the user's group membership in `groupsToOverride`
  // (the user's GROUPS, despite the name — AWS reuses the field for
  // the trigger-output side of the conversation too).
  const groups = event.request.groupConfiguration.groupsToOverride ?? [];
  const allowed = unionAllowedScopes(groups);

  const out: string[] = [];
  for (const scope of requested) {
    if (!scope.startsWith(RESOURCE_SERVER_PREFIX)) continue;
    const name = scope.slice(RESOURCE_SERVER_PREFIX.length);
    if (!allowed.has(name)) out.push(scope);
  }
  return out;
}

/** A user can be in multiple groups; permission is the UNION of every
 * group's allowlist. So a user in both `employee` and `manager`
 * receives manager-level scopes. */
function unionAllowedScopes(groups: string[]): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    const grp = GROUP_SCOPE_ALLOWLIST[g];
    if (!grp) continue;
    for (const scope of grp) out.add(scope);
  }
  return out;
}
