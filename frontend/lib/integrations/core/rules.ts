/** The rule catalog — per-capability policies an admin edits in Settings.
 *
 * Rules live in `integration_rule (capability, key) → jsonb`. This module
 * owns the shape of every known key (zod), the human labels for the
 * editor, and the parse helper the runner and the read side use. A rule
 * the catalog does not know is ignored, never an error — old rows must
 * not break a newer deployment.
 */
import { z } from "zod";

import type { Capability } from "./capabilities";

const Slug = z.string().regex(/^[a-z][a-z0-9_-]*$/);

export const OverlapPolicySchema = z.discriminatedUnion("kind", [
  /** For any (person, day) with time from `integration`, time from every
   *  other source on that day is dropped. Today's awork-over-Personio
   *  dedup. */
  z.object({ kind: z.literal("day_wins"), integration: Slug }),
  /** Keep every source's time; nothing is dropped. */
  z.object({ kind: z.literal("merge") }),
]);

export const AutoLinkSchema = z.object({
  /** Integrations whose unlinked records are auto-linked by the rule. */
  integrations: z.array(Slug),
});

export const ImportPolicySchema = z.object({
  /** The integration whose companies / projects become Dante customers /
   *  projects. Null disables importing altogether. */
  integration: Slug.nullable(),
  customers: z.boolean(),
  projects: z.boolean(),
  /** Provider-specific money fields onto imported projects (awork's Daily
   *  Rate / Fixed Price / Order Number). */
  apply_money: z.boolean(),
  /** Planned dates / budget / notes / status follow the source. */
  refresh_dates: z.boolean(),
});

export type OverlapPolicy = z.infer<typeof OverlapPolicySchema>;
export type AutoLinkRule = z.infer<typeof AutoLinkSchema>;
export type ImportPolicy = z.infer<typeof ImportPolicySchema>;

export type RuleKind = "overlap_policy" | "auto_link" | "import_policy";

export type RuleDefinition = {
  capability: Capability;
  key: string;
  kind: RuleKind;
  label: string;
  description: string;
  schema: z.ZodType;
  /** Value used when the row is missing. */
  fallback: unknown;
};

export const RULE_CATALOG: readonly RuleDefinition[] = [
  {
    capability: "time_entries",
    key: "overlap_policy",
    kind: "overlap_policy",
    label: "Overlapping time",
    description:
      "When two sources report time for the same person on the same day: let one source win the day, or keep both.",
    schema: OverlapPolicySchema,
    fallback: { kind: "merge" } satisfies OverlapPolicy,
  },
  {
    capability: "people",
    key: "auto_link_email",
    kind: "auto_link",
    label: "Auto-link people to employees by e-mail",
    description:
      "After every sync, persons from these integrations whose e-mail matches an employee are linked automatically.",
    schema: AutoLinkSchema,
    fallback: { integrations: [] } satisfies AutoLinkRule,
  },
  {
    capability: "external_contributors",
    key: "auto_link_email",
    kind: "auto_link",
    label: "Auto-link people to freelancers by e-mail",
    description:
      "Persons from these integrations whose e-mail matches a freelancer's contact e-mail are linked automatically.",
    schema: AutoLinkSchema,
    fallback: { integrations: [] } satisfies AutoLinkRule,
  },
  {
    capability: "companies",
    key: "auto_link_name",
    kind: "auto_link",
    label: "Auto-link companies to customers by name",
    description:
      "Companies from these integrations whose name matches a customer (case-insensitive) are linked automatically.",
    schema: AutoLinkSchema,
    fallback: { integrations: [] } satisfies AutoLinkRule,
  },
  {
    capability: "projects",
    key: "import_policy",
    kind: "import_policy",
    label: "Import projects and customers",
    description:
      "Which integration's unlinked companies and projects become Dante customers and projects, and what follows the source afterwards.",
    schema: ImportPolicySchema,
    fallback: {
      integration: null,
      customers: false,
      projects: false,
      apply_money: false,
      refresh_dates: false,
    } satisfies ImportPolicy,
  },
];

export function ruleDefinition(capability: string, key: string): RuleDefinition | undefined {
  return RULE_CATALOG.find((r) => r.capability === capability && r.key === key);
}

/** Parse a stored value against its catalog schema; unknown keys and
 *  malformed values fall back to the definition's default. */
export function parseRule<T = unknown>(capability: string, key: string, value: unknown): T {
  const def = ruleDefinition(capability, key);
  if (!def) return value as T;
  const r = def.schema.safeParse(value);
  return (r.success ? r.data : def.fallback) as T;
}
