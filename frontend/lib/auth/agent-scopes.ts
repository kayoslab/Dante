/** Canonical scope catalog for agent tokens.
 *
 * Scopes partition the data domain by sensitivity. They are NOT a
 * cast of role bits — each scope has explicit semantics that the user
 * is consenting to when they mint a token. The /profile/agents UI
 * shows the description from this file next to the checkbox.
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
  | "read:salaries";

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
    min_role: "employee",
  },
  "read:customers": {
    label: "Read customers",
    description:
      "List customers, their frameworks, and rate-card information.",
    min_role: "employee",
  },
  "read:reports": {
    label: "Read reports",
    description:
      "Portfolio + customer rentability rollups for any month. Does not " +
      "include per-employee economics.",
    min_role: "manager",
  },
  "read:employees": {
    label: "Read employees",
    description:
      "List employees, their teams, role tiers, contract dates. Does NOT " +
      "include salary or Personio personal data.",
    min_role: "manager",
  },
  "read:salaries": {
    label: "Read salaries",
    description:
      "Per-employee salary history + monthly cost data. Equivalent to the " +
      "/employees/[id] detail page reads.",
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
