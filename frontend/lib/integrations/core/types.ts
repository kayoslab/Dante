/** The adapter contract.
 *
 * A provider adapter is the only code that knows an external tool's API.
 * It pulls raw records and returns them in the canonical shapes below;
 * everything after that — upserts, pruning, link resolution, rollups,
 * imports — is core code in `runner.ts` and friends, shared by every
 * provider. Adapters never receive the database connection, except in
 * the optional `afterSync` hook reserved for provider-specific
 * housekeeping (e.g. awork's money fields onto imported projects).
 *
 * See docs/integration-adapters.md.
 */
import type { z } from "zod";
import type { Client } from "pg";

import type { Capability } from "./capabilities";

// ---------------------------------------------------------------------------
// Registry-level metadata
// ---------------------------------------------------------------------------

export type CredentialField = {
  /** Key inside the stored credential document, e.g. "client_secret". */
  key: string;
  label: string;
  /** Rendered as a password field and never read back (phase 3). */
  secret: boolean;
  required?: boolean;
};

export type AuthSpec =
  | { kind: "api_key"; fields: CredentialField[] }
  | { kind: "client_credentials"; fields: CredentialField[] }
  | {
      kind: "oauth2_pkce";
      /** Client registration, entered once by an admin. */
      fields: CredentialField[];
      authorizeUrl: string;
      tokenUrl: string;
      scope: string;
    };

export type HealthStatus =
  | { ok: true; detail?: string }
  | { ok: false; detail: string };

/** One row of `integration`, as the runner loads it. */
export type IntegrationRecord = {
  slug: string;
  provider: string;
  display_name: string;
  enabled: boolean;
  config: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Canonical records — what adapters return
// ---------------------------------------------------------------------------

/** ISO `YYYY-MM-DD`. */
export type DateString = string;

export type DateWindow = { start_date: DateString; end_date: DateString };

export type PullMode = "full" | "incremental";

/** A catalog pull says whether it was a complete scan or a delta, because
 *  the core only archives / prunes unseen rows after a `full` pull. */
export type Pulled<T> = { records: T[]; mode: PullMode };

/** An employee as the HRIS sees them. Materialised into `employee_current`
 *  by the primary `people` binding; also mirrored into `external_person`. */
export type CanonicalEmployee = {
  external_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  department: string | null;
  position: string | null;
  subcompany: string | null;
  office: string | null;
  hire_date: DateString | null;
  contract_end_date: DateString | null;
  employment_end_date: DateString | null;
  employment_type: string | null;
  weekly_working_hours: number | null;
  /** External id of the supervisor in the same integration; resolved to
   *  a Dante employee id through `external_link` by the core. */
  supervisor_external_id: string | null;
  fix_salary: number | null;
  fix_salary_interval: string | null;
  hourly_salary: number | null;
  cost_center: string | null;
  gender: string | null;
  probation_period_end: DateString | null;
  birth_date: DateString | null;
  nationality: string | null;
  notice_period_probation: string | null;
  absence_entitlement: unknown;
  /** Verbatim payload, kept in `raw_employee_snapshot` for replay. */
  raw: unknown;
};

/** A person in a delivery tool (awork user). Linked to an employee or a
 *  freelancer through `external_link`. */
export type CanonicalPerson = {
  external_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  status: string | null;
  is_active: boolean | null;
  is_external: boolean | null;
  extra: Record<string, unknown>;
  source_updated_at: Date | null;
};

export type CanonicalCompany = {
  external_id: string;
  name: string | null;
  is_external: boolean | null;
  extra: Record<string, unknown>;
  source_updated_at: Date | null;
};

export type CanonicalProject = {
  external_id: string;
  name: string | null;
  project_key: string | null;
  external_company_id: string | null;
  parent_external_id: string | null;
  /** The source's own billability flag (null = unknown). */
  billable: boolean | null;
  active: boolean | null;
  status_type: string | null;
  status_name: string | null;
  start_date: DateString | null;
  due_date: DateString | null;
  closed_on: DateString | null;
  time_budget_seconds: number | null;
  description: string | null;
  extra: Record<string, unknown>;
  source_updated_at: Date | null;
};

export type CanonicalAbsence = {
  external_id: string;
  external_person_id: string;
  type_name: string | null;
  start_date: DateString;
  end_date: DateString;
  half_day_start: boolean | null;
  half_day_end: boolean | null;
  days_count: number | null;
  status: string | null;
  comment: string | null;
};

export type CanonicalCompensation = {
  external_id: string;
  external_person_id: string;
  effective_from: DateString | null;
  amount_value: number | null;
  amount_currency: string | null;
  interval: string | null;
  category: string | null;
  type_name: string | null;
  legal_entity_id: string | null;
  weekly_working_hours: number | null;
  full_time_weekly_working_hours: number | null;
};

export type CanonicalTimeEntry = {
  external_id: string;
  /** Null when the tool reports an entry without a person (awork does);
   *  the entry still counts toward its project. */
  external_person_id: string | null;
  external_project_id: string | null;
  external_task_id: string | null;
  work_date: DateString;
  start_at: Date | null;
  end_at: Date | null;
  duration_minutes: number;
  is_billable: boolean | null;
  is_billed: boolean | null;
  status: string | null;
  note: string | null;
  type_of_work: string | null;
  extra: Record<string, unknown>;
  source_updated_at: Date | null;
};

export type CanonicalBooking = {
  external_id: string;
  external_person_id: string;
  external_project_id: string;
  start_date: DateString;
  end_date: DateString;
  duration_seconds: number;
  description: string | null;
  extra: Record<string, unknown>;
  source_created_at: Date | null;
  source_updated_at: Date | null;
};

// ---------------------------------------------------------------------------
// Context handed to adapters
// ---------------------------------------------------------------------------

export type SyncLogger = (line: string) => void;

/** What a pull method may see. Deliberately narrow: no connection. */
export interface PullContext {
  integration: IntegrationRecord;
  sync_run_id: number;
  log: SyncLogger;
  /** Newest `source_updated_at` already stored for this integration and
   *  capability — the delta high-water mark. Null when nothing is stored
   *  yet, in which case the adapter should do a full pull. */
  highWaterMark(capability: Capability): Promise<Date | null>;
}

export type CatalogPullOptions = {
  /** Force a complete scan (manual "Sync" button / reconciliation). */
  full: boolean;
};

export type TimeEntryPullOptions = CatalogPullOptions & {
  window: DateWindow;
};

/** The wider context for `afterSync`. This is the one place an adapter
 *  may touch Dante tables, for provider-specific housekeeping that has
 *  no canonical home yet. Keep such hooks small and idempotent. */
export interface SyncContext extends PullContext {
  conn: Client;
  /** Per-capability rules (`integration_rule`), keyed `capability.key`. */
  rules: ReadonlyMap<string, Record<string, unknown>>;
}

export type ClientContext<Config> = {
  integration: IntegrationRecord;
  config: Config;
  log: SyncLogger;
};

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface ProviderAdapter<
  ProviderClient = unknown,
  Config extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Registry key. An integration row's `provider` column points here. */
  slug: string;
  displayName: string;
  docsUrl?: string;
  auth: AuthSpec;
  /** Provider-specific, non-secret settings. Drives the admin form. */
  configSchema: z.ZodType<Config>;
  capabilities: readonly Capability[];
  /** Files under this provider's folder that may issue HTTP writes
   *  (an OAuth token endpoint, say). Everything else must stay GET-only;
   *  enforced by `scripts/check-integration-readonly.ts`. */
  writesAllowedIn: readonly string[];

  createClient(ctx: ClientContext<Config>): Promise<ProviderClient>;
  healthCheck(client: ProviderClient): Promise<HealthStatus>;

  /** `people` */
  pullEmployees?(client: ProviderClient, ctx: PullContext): Promise<CanonicalEmployee[]>;
  /** `external_contributors` */
  pullPersons?(client: ProviderClient, ctx: PullContext): Promise<CanonicalPerson[]>;
  /** `companies` */
  pullCompanies?(
    client: ProviderClient,
    ctx: PullContext,
    opts: CatalogPullOptions,
  ): Promise<Pulled<CanonicalCompany>>;
  /** `projects` */
  pullProjects?(
    client: ProviderClient,
    ctx: PullContext,
    opts: CatalogPullOptions,
  ): Promise<Pulled<CanonicalProject>>;
  /** `absences` */
  pullAbsences?(
    client: ProviderClient,
    ctx: PullContext,
    window: DateWindow,
  ): Promise<CanonicalAbsence[]>;
  /** `compensations` */
  pullCompensations?(client: ProviderClient, ctx: PullContext): Promise<CanonicalCompensation[]>;
  /** `time_entries` */
  pullTimeEntries?(
    client: ProviderClient,
    ctx: PullContext,
    opts: TimeEntryPullOptions,
  ): Promise<Pulled<CanonicalTimeEntry>>;
  /** `planned_bookings` */
  pullPlannedBookings?(client: ProviderClient, ctx: PullContext): Promise<CanonicalBooking[]>;

  /** Provider housekeeping after the core has upserted, linked, rolled
   *  up and imported. Optional. */
  afterSync?(client: ProviderClient, ctx: SyncContext): Promise<void>;
}

/** Which pull method a capability maps to — used by the runner and by
 *  the adapter conformance test. */
export const CAPABILITY_METHOD = {
  people: "pullEmployees",
  external_contributors: "pullPersons",
  companies: "pullCompanies",
  projects: "pullProjects",
  absences: "pullAbsences",
  compensations: "pullCompensations",
  time_entries: "pullTimeEntries",
  planned_bookings: "pullPlannedBookings",
} as const satisfies Record<Capability, keyof ProviderAdapter>;
