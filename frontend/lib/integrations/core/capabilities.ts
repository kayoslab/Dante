/** Capability vocabulary for external integrations.
 *
 * A capability is a slice of data an external tool can supply to Dante.
 * The set is owned by Dante, not by any provider: an adapter declares
 * which of these it implements, and an admin binds each capability to
 * one or more integrations in priority order (`integration_binding`).
 *
 * `CAPABILITY_ORDER` is the order the sync runner processes them in —
 * later capabilities depend on earlier ones being resolved (time entries
 * reference people and projects; planned bookings reference both).
 *
 * See docs/integration-adapters.md.
 */
export const CAPABILITY_ORDER = [
  /** Employees of the company (the HRIS view of a person). The primary
   *  binding is the only one allowed to create `employee_current` rows. */
  "people",
  /** People who work on projects but are not employees (freelancers).
   *  Persons from this source may be linked to `freelancer` rows. */
  "external_contributors",
  /** Customer-side organisations (awork companies). */
  "companies",
  /** Projects as the external tool sees them. Both "real" delivery
   *  projects (awork) and time-attribution dropdowns (Personio) land here;
   *  what Dante does with them is a rule, not a capability. */
  "projects",
  /** Time-off records. */
  "absences",
  /** Salary / compensation events. */
  "compensations",
  /** Tracked hours (attendance periods, time entries). */
  "time_entries",
  /** Forward-looking planner bookings. */
  "planned_bookings",
] as const;

export type Capability = (typeof CAPABILITY_ORDER)[number];

export const CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITY_ORDER);

export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && CAPABILITIES.has(value as Capability);
}

/** What an `external_link` row points *from* (a record in the external
 *  tool) and *to* (a Dante entity). `person` may resolve to an employee
 *  or a freelancer; the pair is validated in `LINK_TARGETS`. */
export const EXTERNAL_ENTITY_TYPES = ["person", "project", "company"] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export const DANTE_ENTITY_TYPES = [
  "employee",
  "freelancer",
  "project",
  "customer",
] as const;
export type DanteEntityType = (typeof DANTE_ENTITY_TYPES)[number];

export const LINK_TARGETS: Record<ExternalEntityType, readonly DanteEntityType[]> = {
  person: ["employee", "freelancer"],
  project: ["project"],
  company: ["customer"],
};

/** Provenance of an `external_link` row.
 *  - `manual`     — set by a person in the UI
 *  - `auto:email` — auto-link rule, e-mail match
 *  - `auto:name`  — auto-link rule, name match
 *  - `source`     — created together with the Dante entity by the sync
 *                   (a new employee from the HRIS, an imported project)
 *  - `backfill`   — migrated from a legacy link table (0023)
 *  - `legacy`     — mirrored from a legacy link table during phase 1 */
export type LinkOrigin =
  | "manual"
  | "auto:email"
  | "auto:name"
  | "source"
  | "backfill"
  | "legacy";
