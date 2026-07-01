/** Canonical scope catalog for agent tokens.
 *
 * Scopes partition the data domain by sensitivity. They are NOT a
 * cast of role bits — each scope has explicit semantics that the user
 * is consenting to when they mint a token. The /profile/agents UI
 * shows the description from this file next to the checkbox.
 *
 * INVARIANT: an agent token cannot access more than the underlying
 * user could access via the web. The hierarchy admin > manager >
 * employee is enforced at TWO layers:
 *
 *   1. Mint-time: `callerMayMintScope(role, scope)` rejects requests
 *      to mint a scope above the caller's role tier. An employee
 *      cannot grant `read:projects` (manager-tier); a manager cannot
 *      grant a future `admin:audit` (admin-tier). The /profile/agents
 *      UI only renders the checkboxes the caller is allowed to grant.
 *
 *   2. Use-time: `requireAgentSession` re-derives the required
 *      min_role from this catalog and rejects a token whose owner's
 *      role has dropped below it. Defense in depth — even if the
 *      Pre Token Generation Lambda issues a token with a scope it
 *      shouldn't have, Dante rejects the call.
 *
 * Both layers consult ROLE_RANK from `session.ts` (admin=2, manager=1,
 * employee=0). The natural ordering gives admin a strict superset of
 * manager's reach, and manager a strict superset of employee's.
 *
 * When you add a scope here, set `min_role` to mirror the role gate
 * the equivalent web route uses (see the per-role endpoint matrix in
 * AGENTS.md). The web route is the single source of truth for who
 * may see what — the scope catalog must follow it, never widen it.
 *
 * Adding a scope:
 *   1. Add a new entry to `AGENT_SCOPES` below.
 *   2. Use it in the route via `requireAgentSession({ scope: '...' })`.
 *   3. The token-creation UI picks it up automatically because the
 *      catalog is the single source of truth.
 *
 * Removing a scope is a breaking change for any token that was minted
 * with it — surface a migration plan before doing this. */
import type { Role } from "./config";

import { ROLE_RANK } from "./session";

export type AgentScope =
  | "read:projects"
  | "read:customers"
  | "read:reports"
  | "read:employees"
  | "read:salaries"
  | "write:customers"
  | "write:frameworks"
  | "write:projects"
  | "write:allocations"
  | "write:time_tracking"
  | "write:freelancers";

type ScopeDef = {
  /** Concise label shown next to the checkbox in /profile/agents. */
  label: string;
  /** Explainer shown under the label so the user understands what
   * they're consenting to. Aim for one sentence. */
  description: string;
  /** Lowest role that may mint this scope. The mint-time guard in
   * `createAgentTokenAction` enforces it. */
  min_role: Role;
};

export const AGENT_SCOPES: Record<AgentScope, ScopeDef> = {
  "read:projects": {
    label: "Read projects",
    description:
      "List active projects, read per-project monthly P&L, FP burn-down state, " +
      "agreed amounts, planned dates.",
    // Mirrors the web role matrix in AGENTS.md — `/api/projects/*` is
    // manager-only, so the agent equivalent must be too. Letting an
    // employee mint this scope would be a privilege escalation:
    // employees in the web UI see only their own assigned projects,
    // never the full portfolio.
    min_role: "manager",
  },
  "read:customers": {
    label: "Read customers",
    description:
      "List customers, their frameworks, and rate-card information.",
    // Same reasoning as read:projects — `/api/customers/*` is
    // manager-only in the web matrix.
    min_role: "manager",
  },
  "read:reports": {
    label: "Read reports",
    description:
      "Portfolio + customer rentability rollups for any month. Does not " +
      "include per-employee economics.",
    // Web equivalent: `/api/reports/*` + `/api/portfolio-rentability/*`
    // — both manager-only.
    min_role: "manager",
  },
  "read:employees": {
    label: "Read employees",
    description:
      "List employees, their teams, role tiers, contract dates. Does NOT " +
      "include salary or Personio personal data.",
    // Web equivalent: `/api/employees` (the LIST, no detail) is
    // employee-accessible per AGENTS.md's role matrix. Employees can
    // see the directory of every active colleague on the web; the
    // agent endpoint mirrors that and stays at employee tier. The
    // per-employee detail surface (salary, monthly economics) is
    // covered by `read:salaries` which is properly gated to manager+.
    min_role: "employee",
  },
  "read:salaries": {
    label: "Read salaries",
    description:
      "Per-employee monthly economics: loaded cost, billable revenue, " +
      "margin, utilization. Per the AGENTS.md role matrix the underlying " +
      "`/api/employees/[id]/monthly*` is manager-only.",
    min_role: "manager",
  },
  // --- Write scopes ---------------------------------------------------
  // Every write scope mirrors the role gate the equivalent Server
  // Action uses (`lib/actions/*.ts` — `requireActionRole("manager")` on
  // create/update/delete throughout). Employees never mutate Dante data
  // on the web, so they don't mutate it via the agent either.
  //
  // On the agent client, write tools sit behind an EVE connection-level
  // `approval: always()`-style policy so every mutation parks the run
  // for explicit user confirmation in the chat UI. Defense in depth —
  // the scope gate prevents minting the tool at all for the wrong
  // role; the approval policy stops accidental writes by the model
  // even for users who DO have the scope.
  "write:customers": {
    label: "Create + update customers",
    description:
      "Create new customers and update name / notes on existing ones. " +
      "Same role gate as `createCustomerAction` on the web.",
    min_role: "manager",
  },
  "write:frameworks": {
    label: "Create + update framework agreements",
    description:
      "Create framework agreements + their rate cards, update dates and " +
      "notes. Same role gate as `createFrameworkAction` on the web.",
    min_role: "manager",
  },
  "write:projects": {
    label: "Create + update projects",
    description:
      "Create projects (T&M or Fixed-Price), set agreed amount, planned " +
      "dates, billing model, and rate card. Same role gate as " +
      "`createProjectAction` on the web.",
    min_role: "manager",
  },
  "write:allocations": {
    label: "Manage allocations",
    description:
      "Create new project allocations and extend the end date of " +
      "existing ones. Same role gate as `insertAssignmentAction` / " +
      "`endAssignmentAction` on the web.",
    min_role: "manager",
  },
  "write:time_tracking": {
    label: "Enter freelancer time-tracking",
    description:
      "Upsert monthly hours for a freelancer assignment. Manual " +
      "entries override the awork sync for the same month. Same role " +
      "gate as `upsertFreelancerHoursAction` on the web.",
    min_role: "manager",
  },
  "write:freelancers": {
    label: "Create + update freelancers",
    description:
      "Create new freelancers (name + daily cost) and update fields on " +
      "existing ones. Same role gate as `createFreelancerAction` / " +
      "`updateFreelancerAction` on the web.",
    min_role: "manager",
  },
};

/** Is `scope` something a caller with `role` is allowed to mint? */
export function callerMayMintScope(role: Role, scope: AgentScope): boolean {
  const def = AGENT_SCOPES[scope];
  if (!def) return false;
  return ROLE_RANK[role] >= ROLE_RANK[def.min_role];
}

/** Parses an unknown string against the catalog. Used at the route
 * boundary (mint payload, lookup). Returns null for unknown values
 * rather than throwing — callers decide whether unknowns are an
 * error or just a skipped-checkbox case. */
export function parseAgentScope(raw: string): AgentScope | null {
  return raw in AGENT_SCOPES ? (raw as AgentScope) : null;
}
