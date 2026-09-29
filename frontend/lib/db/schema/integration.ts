/** Integration model — the provider-agnostic half of the schema.
 *
 * Introduced by migration 0023 (phase 1 of docs/integration-adapters.md).
 * Nothing here is provider-specific: Personio and awork are rows in
 * `integration`, and everything they pull lands in the canonical tables
 * below tagged with their slug. The per-provider tables in personio.ts and
 * awork.ts are retired in phase 2 once the adapters write here instead.
 *
 * During phase 1 the five legacy link tables remain the write path for
 * links; row-level triggers (see the migration) mirror every change into
 * `external_link` so both stay consistent until phase 2 flips the
 * direction.
 */
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import type {
  Capability,
  DanteEntityType,
  ExternalEntityType,
  LinkOrigin,
} from "@/lib/integrations/core/capabilities";

/** Credential lifecycle as far as Dante can tell without reading the
 *  secret back:
 *  - `missing`  — nothing has been set through Dante.
 *  - `set`      — an admin stored a credential through the UI (phase 3).
 *  - `invalid`  — the last health check / sync rejected it.
 *  - `external` — managed outside Dante (env vars / Secrets Manager seeded
 *                 by ops). The pre-phase-3 state of every integration. */
export type CredentialState = "missing" | "set" | "invalid" | "external";

/** An admin-enabled instance of a provider. Keyed by slug rather than by
 *  provider so a second workspace of the same tool stays possible. */
export const integration = pgTable("integration", {
  slug: text().primaryKey(),
  provider: text().notNull(),
  display_name: text().notNull(),
  enabled: boolean().notNull().default(false),
  /** Provider-specific, non-secret settings validated by the adapter's
   *  `configSchema`. */
  config: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
  credential_state: text()
    .notNull()
    .default("missing")
    .$type<CredentialState>(),
  credential_set_at: timestamp({ mode: "date" }),
  credential_set_by: text(),
  last_sync_at: timestamp({ mode: "date" }),
  last_sync_status: text(),
  last_error: text(),
  created_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
});

/** Backing rows for the database flavour of the secret store — one
 *  encrypted document per (integration, kind). Never read by the app
 *  directly; see lib/integrations/core/secret-store.ts. */
export const integrationSecret = pgTable(
  "integration_secret",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    kind: text().notNull().$type<"credentials" | "tokens">(),
    ciphertext: text().notNull(),
    iv: text().notNull(),
    tag: text().notNull(),
    key_version: integer().notNull().default(1),
    updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.integration_slug, t.kind] })],
);

/** The logical connection: which integration feeds which capability, and
 *  in what order when several do. `priority` 0 is the primary source. */
export const integrationBinding = pgTable(
  "integration_binding",
  {
    capability: text().notNull().$type<Capability>(),
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    priority: integer().notNull().default(0),
    enabled: boolean().notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.capability, t.integration_slug] }),
    unique("uq_integration_binding_priority").on(t.capability, t.priority),
  ],
);

/** Per-capability policy the core applies around the adapters —
 *  reconciliation between overlapping sources, auto-link rules, import
 *  policy. Values are small JSON documents; the shape per key is owned by
 *  `lib/integrations/core` (phase 2) and edited in Settings (phase 4). */
export const integrationRule = pgTable(
  "integration_rule",
  {
    capability: text().notNull().$type<Capability>(),
    key: text().notNull(),
    value: jsonb().notNull().$type<Record<string, unknown>>(),
    updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.capability, t.key] })],
);

/** One generic mapping from a record in an external tool to a Dante
 *  entity. Replaces personio_project_link, awork_project_link,
 *  awork_user_link, awork_freelancer_link and awork_company_link.
 *
 *  No FK on `dante_id` (it is polymorphic over `dante_type`); the phase-2
 *  core deletes links when the target entity goes away. Several external
 *  records may map to the same Dante entity (flat sub-projects), so there
 *  is deliberately no uniqueness on the Dante side. */
export const externalLink = pgTable(
  "external_link",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    entity_type: text().notNull().$type<ExternalEntityType>(),
    external_id: text().notNull(),
    dante_type: text().notNull().$type<DanteEntityType>(),
    dante_id: integer().notNull(),
    origin: text().notNull().default("manual").$type<LinkOrigin>(),
    mapped_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.entity_type, t.external_id] }),
    index("external_link_dante_idx").on(t.dante_type, t.dante_id),
  ],
);

// ---------------------------------------------------------------------------
// Canonical landing tables. Every row is tagged with the integration it came
// from and keyed by the tool's own id. `extra` carries provider-specific
// fields the core doesn't interpret (awork money fields, planner lane order)
// for the adapter's `afterSync` hook. `source_updated_at` is the tool's own
// modification stamp, used for delta pulls; `last_seen_sync_run_id` drives
// pruning of records that vanished upstream.
// ---------------------------------------------------------------------------

/** A person as the external tool sees them. Replaces awork_user; Personio
 *  persons land here too, and the primary `people` binding additionally
 *  materialises them into employee_current. */
export const externalPerson = pgTable(
  "external_person",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    first_name: text(),
    last_name: text(),
    email: text(),
    /** The tool's own status string, verbatim. */
    status: text(),
    /** Normalised by the adapter: can this person still be assigned work? */
    is_active: boolean(),
    is_external: boolean(),
    extra: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
    source_updated_at: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer(),
    last_updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    index("external_person_email_idx").on(t.email),
  ],
);

/** Replaces awork_company. */
export const externalCompany = pgTable(
  "external_company",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    name: text(),
    is_external: boolean(),
    extra: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
    source_updated_at: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer(),
    last_updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    index("external_company_name_idx").on(t.name),
  ],
);

/** Replaces awork_project and personio_project. */
export const externalProject = pgTable(
  "external_project",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    name: text(),
    project_key: text(),
    /** Same integration's company id, or null. */
    external_company_id: text(),
    /** Same integration's parent project id (sub-projects), or null. */
    parent_external_id: text(),
    /** The source's own billability flag. Only authoritative for an
     *  UNLINKED project; a linked one defers to `project.billable`. */
    billable: boolean(),
    active: boolean(),
    status_type: text(),
    status_name: text(),
    start_date: date({ mode: "string" }),
    due_date: date({ mode: "string" }),
    closed_on: date({ mode: "string" }),
    time_budget_seconds: bigint({ mode: "number" }),
    description: text(),
    extra: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
    source_updated_at: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer(),
    last_updated_at: timestamp({ mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    index("external_project_company_idx").on(
      t.integration_slug,
      t.external_company_id,
    ),
  ],
);

/** Tracked time. Replaces attendance (Personio WORK periods) and
 *  awork_time_entry. `external_person_id` / `external_project_id` are ids
 *  in the SAME integration; resolution to Dante entities goes through
 *  external_link. */
export const timeEntry = pgTable(
  "time_entry",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    /** Nullable: awork can report entries without a user; they still
     *  count toward their project. */
    external_person_id: text(),
    external_project_id: text(),
    external_task_id: text(),
    work_date: date({ mode: "string" }).notNull(),
    start_at: timestamp({ mode: "date" }),
    end_at: timestamp({ mode: "date" }),
    duration_minutes: integer().notNull(),
    is_billable: boolean(),
    is_billed: boolean(),
    /** Approval status where the tool has one (Personio PENDING /
     *  CONFIRMED / REJECTED). Persisted, not yet consumed. */
    status: text(),
    note: text(),
    type_of_work: text(),
    extra: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
    source_updated_at: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    index("time_entry_person_date_idx").on(
      t.integration_slug,
      t.external_person_id,
      t.work_date,
    ),
    index("time_entry_date_idx").on(t.work_date),
    index("time_entry_project_idx").on(
      t.integration_slug,
      t.external_project_id,
    ),
  ],
);

/** Planner entries. Replaces awork_time_booking. */
export const plannedBooking = pgTable(
  "planned_booking",
  {
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    external_person_id: text().notNull(),
    external_project_id: text().notNull(),
    start_date: date({ mode: "string" }).notNull(),
    end_date: date({ mode: "string" }).notNull(),
    duration_seconds: integer().notNull(),
    description: text(),
    extra: jsonb().notNull().default({}).$type<Record<string, unknown>>(),
    source_created_at: timestamp({ mode: "date" }),
    source_updated_at: timestamp({ mode: "date" }),
    last_seen_sync_run_id: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    index("planned_booking_person_window_idx").on(
      t.integration_slug,
      t.external_person_id,
      t.start_date,
      t.end_date,
    ),
  ],
);
