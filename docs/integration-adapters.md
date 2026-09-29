# Integration adapters — design and build plan

Status: agreed design (2026-09-29). Phases 1 (migration 0023), 2 (adapter
extraction, canonical writes, migration 0024), 3 (secret store,
write-only credential UI, migration 0025) and 4 (integrations, sources &
rules settings) implemented. The code lives
under `frontend/lib/integrations/`; `frontend/lib/sync/` keeps only the
connection helper, the Lambda handler and a re-export of `runSync`.
Phases 5-6 pending.

Dante pulls people from an HRIS and work from a project / time-tracking
tool. Today those are Personio and awork, and both are hard-wired: the
sync runner has one function per provider, the schema is provider-shaped,
nine report queries union the two by name, and every link table, link
card, API route and settings page is per-provider.

This document describes how the two become instances of one **adapter
contract**, how an admin configures the **logical connection** between
integrations and Dante in Settings, and in what order to build it so a
third tool is a pure adapter job.

## Decisions already taken

| Question | Decision |
| --- | --- |
| What "logical connection" means | Capability bindings, precedence between sources, auto-link rules. All configurable per connector by an admin. |
| Where credentials live | Set by an admin in the UI through a write-only password field. Never readable back. Stored in a pluggable secret store (see Phase 3). |
| Employee primary key | Decoupled from Personio's person ID via an identity column + `external_link`. Backfill keeps existing values equal. |
| Instances per provider | One per provider slug for now. Schema keyed by integration slug so two workspaces stay possible later. |
| Write-back to external tools | Not in scope. Adapters stay read-only; the read-only guard is generalised, not removed. |

## Vocabulary

- **Provider** — code. One adapter module per external tool, registered in a
  static registry. Examples: `personio`, `awork`.
- **Capability** — a slice of data a provider can supply. Fixed set owned by
  Dante (`CAPABILITY_ORDER` in `lib/integrations/core/capabilities.ts`):
  `people`, `external_contributors` (freelancers), `companies`, `projects`,
  `absences`, `compensations`, `time_entries`, `planned_bookings`. Both
  Personio's time-attribution dropdown and awork's delivery projects are
  `projects`; whether Dante *imports* projects from a source is a rule
  (`projects.import_policy`), not a capability.
- **Integration** — a database row. An admin-enabled instance of a provider
  with its config and credential status.
- **Binding** — the logical connection. For each capability: which
  integration is the source, and the precedence order when more than one
  supplies it.
- **External link** — one generic mapping `(integration, entity_type,
  external_id) → (dante_entity_type, dante_id)`, replacing the five
  per-provider link tables.
- **Reconciliation rule** — per-capability policy applied by the core when
  two sources overlap (e.g. "a day with awork time drops the Personio
  attendance for that day").

## Adapter contract

The shipped contract is in `lib/integrations/core/types.ts`; the sketch
below is kept in step with it. Pull methods return arrays (every source
API returns complete lists anyway), catalog pulls report whether they
were `full` or `incremental`, and delta high-water marks come from the
core through `PullContext.highWaterMark(capability)`.

```ts
// lib/integrations/core/types.ts
export type Capability =
  | "people" | "external_contributors" | "companies" | "projects"
  | "absences" | "compensations" | "time_entries" | "planned_bookings";

export type AuthSpec =
  | { kind: "api_key"; fields: { key: string; label: string; secret: boolean }[] }
  | { kind: "client_credentials"; fields: [...] }
  | { kind: "oauth2_pkce"; authorizeUrl: string; tokenUrl: string; scopes: string[] };

export interface ProviderAdapter<Config = unknown> {
  slug: string;
  displayName: string;
  docsUrl?: string;
  auth: AuthSpec;
  /** Provider-specific, non-secret settings. Drives the admin form. */
  configSchema: z.ZodType<Config>;
  capabilities: Capability[];
  /** Files under the provider folder allowed to issue HTTP writes
   *  (OAuth token endpoint etc.). Consumed by the read-only guard. */
  writesAllowedIn: string[];

  createClient(ctx: { integration, config, log }): Promise<ProviderClient>;
  healthCheck(client: ProviderClient): Promise<HealthStatus>;

  pullEmployees?(client, ctx: PullContext): Promise<CanonicalEmployee[]>;        // people
  pullPersons?(client, ctx): Promise<CanonicalPerson[]>;                         // external_contributors
  pullCompanies?(client, ctx, { full }): Promise<Pulled<CanonicalCompany>>;
  pullProjects?(client, ctx, { full }): Promise<Pulled<CanonicalProject>>;
  pullAbsences?(client, ctx, window): Promise<CanonicalAbsence[]>;
  pullCompensations?(client, ctx): Promise<CanonicalCompensation[]>;
  pullTimeEntries?(client, ctx, { window, full }): Promise<Pulled<CanonicalTimeEntry>>;
  pullPlannedBookings?(client, ctx): Promise<CanonicalBooking[]>;

  /** Optional provider housekeeping after the core has upserted, linked,
   *  rolled up and imported. The one place an adapter sees the connection
   *  (awork: money fields onto imported projects; Personio: the
   *  salary-history walk). */
  afterSync?(client, ctx: SyncContext): Promise<void>;
}
```

`people` is special: the primary binding materialises `CanonicalEmployee`
records into `employee_current` (resolving each through its
`external_link`, minting a Dante id for a person seen for the first time)
and mirrors them into `external_person`. Every other capability lands in
its canonical table only.

Rules that make the contract hold:

- Adapters return **canonical records** and never touch Dante tables. Upserts,
  retention, link resolution and rollups are core code.
- A provider may keep a **staging table** for fields that are genuinely its
  own (awork's `daily_rate_eur`, `fixed_price_eur`, planner lane order). The
  staging table is written by core helpers from an `extra: jsonb` on the
  canonical record, not by the adapter.
- Every canonical record carries `external_id` and `updated_at` (nullable) so
  the core can do delta pulls and prune vanished rows uniformly.
- `PullContext` exposes `log`, `integration`, `highWaterMark(capability)` and
  nothing else; adapters cannot reach the connection.

Module layout (as shipped):

```
frontend/lib/integrations/
  core/
    capabilities.ts   capability + link vocabulary
    types.ts          contract + canonical DTOs
    registry.ts       static list of adapters (no side effects on import)
    config.ts         loads integration / binding / rule rows for a run
    runner.ts         orchestrator: bindings → adapters → core upserts
    upsert.ts         canonical upserts + per-capability prune/archive
    links.ts          external_link helpers + auto-link rules
    rollups.ts        planned bookings → assignment, hours → freelancer months
    import.ts         import policy: companies → customers, projects → projects
    credentials.ts    secret loading (env / Secrets Manager); SecretStore in phase 3
    excluded-set.ts   ON CONFLICT helper
    retention.ts      audit-log retention
    registry.test.ts  adapter conformance test
  providers/
    personio/         adapter.ts + client, flatten, attendance, absences, compensations
    awork/            adapter.ts + client, auth, schemas, money (afterSync)
frontend/lib/sync/    db.ts (connection), lambda.ts (handler), run.ts (re-export)
```

Reconciliation between overlapping sources (`time_entries.overlap_policy`)
is a *read-side* rule and is applied in phase 5; the runner does not
consult it.

## Data model

Tables as shipped in migration 0023 (timestamps are `timestamp` without
zone, matching the rest of the schema):

```sql
integration (
  slug            text primary key,        -- 'personio', 'awork'
  provider        text not null,           -- registry key
  display_name    text not null,
  enabled         boolean not null default false,
  config          jsonb not null default '{}',
  credential_state text not null default 'missing',  -- missing | set | invalid | external
                                           -- 'external' = managed outside Dante (env / Secrets Manager)
  credential_set_at timestamptz, credential_set_by text,
  last_sync_at    timestamptz, last_sync_status text, last_error text,
  created_at, updated_at
)

integration_binding (
  capability       text not null,
  integration_slug text not null references integration(slug) on delete cascade,
  priority         integer not null,        -- 0 = primary
  enabled          boolean not null default true,
  primary key (capability, integration_slug),
  unique (capability, priority)
)

integration_rule (                          -- per-capability reconciliation + auto-link
  capability       text not null,
  key              text not null,           -- 'overlap_policy', 'auto_link_email', 'auto_link_name'
  value            jsonb not null,
  primary key (capability, key)
)

external_link (
  integration_slug text not null references integration(slug) on delete cascade,
  entity_type      text not null,           -- 'person' | 'project' | 'company'
  external_id      text not null,
  dante_type       text not null,           -- 'employee' | 'freelancer' | 'project' | 'customer'
                                            -- (person → employee|freelancer, checked by constraint)
  dante_id         integer not null,
  origin           text not null,           -- 'manual' | 'auto:email' | 'auto:name' | 'backfill' | 'legacy'
  mapped_at        timestamptz not null,
  primary key (integration_slug, entity_type, external_id)
)
```

Canonical landing tables, each with `integration_slug`, `external_id`,
`last_seen_sync_run_id`, `source_updated_at`, and a jsonb `extra`:
`external_person` (replaces `awork_user`), `external_company` (replaces
`awork_company`), `external_project` (replaces `awork_project` +
`personio_project`), `time_entry` (replaces `attendance` +
`awork_time_entry`), `planned_booking` (replaces `awork_time_booking`).
Created empty in 0023. `absence` and `compensation_event` are reshaped in
place (slug + external id, new PK) in phase 2 when their writer moves — the
current sync cannot fill those columns, so doing it in phase 1 would not
have been behaviour-neutral.

Employee identity:

- `employee_current.employee_id` becomes `generated by default as identity`,
  sequence started at `max(employee_id) + 1`.
- Backfill one `external_link ('personio','person',employee_id::text →
  'employee', employee_id)` per existing row. Values stay equal; nothing
  visible changes.
- `pullPeople` records resolve to an employee through `external_link`; an
  unlinked person from the primary `people` source is inserted with a fresh
  identity and linked. Lower-priority `people` sources never insert.

Migration 0024 (phase 2) copies every legacy row into the canonical
tables (provider-specific columns into `extra`), drops the legacy tables
and recreates each as a compatibility **view** with the same name and
columns, recreates `tracked_time_effective` verbatim over the views, and
adds `external_link_cascade` triggers so deleting a project / customer /
freelancer / employee removes its links (the FK cascades the legacy link
tables had). `absence` and `compensation_event` gain `integration_slug`
and a (slug, external id) primary key in place.

Link-table migration: 0023 backfills `personio_project_link`,
`awork_project_link`, `awork_user_link`, `awork_freelancer_link`,
`awork_company_link` into `external_link` and installs row-level mirror
triggers (one generic `external_link_mirror()` function, parametrised per
table) so the legacy tables stay the write path and `external_link` stays
consistent until phase 2. An `AFTER INSERT` trigger on `employee_current`
adds the `('personio','person')` link for every employee the Personio sync
creates. Phase 2 flips the direction: core writes `external_link`, the
triggers and legacy tables are dropped, and each legacy table becomes a
compatibility view for one release so any missed reader fails loudly.

The Personio employee sync calls `bumpEmployeeIdSequence()` after its
upserts so explicit Personio ids can never collide with a later generated
one.

## Runner

`runSync(opts)` keeps its signature. `SyncOptions.source` becomes
`string[] | "all"` of integration slugs. Algorithm:

1. Load enabled integrations, bindings and rules.
2. Open one `sync_run` per invocation (awork's timestamp pseudo-run goes away).
3. For each capability in dependency order (`people`, `companies`,
   `projects`, `project_catalog`, `external_contributors`, `absences`,
   `compensations`, `time_entries`, `planned_bookings`): for each binding by
   priority, resolve credentials, `createClient`, pull, upsert canonical
   rows tagged with the slug.
4. Run core link resolution + auto-link rules (email, name) per
   `integration_rule`.
5. Run core rollups (planning → assignments, hours → freelancer months).
6. Call each integration's `afterSync`.
7. Audit retention, as today.

Per-integration failures are caught and recorded in `integration.last_error`;
they don't stop other integrations. Health checks reuse the same path with
`{ mode: "health_check", integration: slug }` so the Lambda, not the web app,
touches static credentials in prod.

## Credentials

Write-only from the admin's point of view. The UI posts a credential, the
server stores it, the API only ever returns `credential_state`,
`credential_set_at`, `credential_set_by`.

`SecretStore` interface (`lib/integrations/core/secret-store.ts`) with
three implementations, chosen by deployment env (`DANTE_SECRET_STORE`
explicit, else `DANTE_USE_SECRETS_MANAGER=1` → Secrets Manager, else
`DANTE_SECRET_KEY` → encrypted column, else env):

- **env** — the `<SLUG>_<FIELD>` variables in `.env`. Read-only from the
  UI (the form explains why); OAuth tokens are still rewritten to `.env`
  in dev.

- **Secrets Manager** (`DANTE_USE_SECRETS_MANAGER=1`, AWS deployments).
  Secret name `dante/<env>/integration/<slug>`. The web-app task role gets
  `CreateSecret`, `PutSecretValue`, `DescribeSecret` on that prefix and **no**
  `GetSecretValue` for static credentials, preserving today's rule that only
  the sync Lambda can read Personio credentials. OAuth tokens keep the
  existing web-app read/write grant because the re-authorise flow needs it.
- **Encrypted column** (default for self-hosted / local). `integration_secret
  (slug, ciphertext, nonce, key_version)` encrypted with AES-256-GCM under a
  key from `DANTE_SECRET_KEY`. Documented as the simpler but weaker option.

Both implement `put(slug, value)`, `get(slug)` (throws in the web app when the
store forbids reads), `status(slug)`, `rotate(slug, value)`. awork's token
rotation becomes `AuthSpec.kind === "oauth2_pkce"` behaviour in core, so any
OAuth provider gets refresh + re-authorise for free.

## Admin settings

`/settings/integrations`:

- List of configured integrations: enabled toggle, credential state, last
  sync, last error, "Test connection", "Sync now".
- "Add integration" offers registry entries not yet configured.

`/settings/integrations/[slug]`:

- Provider config form rendered from `configSchema` (zod → fields).
- Credential section rendered from `AuthSpec`: password fields for `api_key`
  / `client_credentials` (shows "set on <date> by <user>", never the value),
  or Authorize / Re-authorize for `oauth2_pkce`.
- Capabilities this integration provides, each with "is primary / priority"
  as shown in the bindings.

`/settings/integrations/bindings` (the logical connection; shipped as
"Sources & rules"). Rule shapes live in `lib/integrations/core/rules.ts`
(`RULE_CATALOG`: zod schema + label + fallback per key); the config form
is rendered from the adapter's `configSchema` by
`lib/integrations/core/config-form.ts` (string / number / boolean / enum,
anything else as JSON). Bindings are replaced per capability in one
transaction; every write is audited (`binding_changed`, `rule_changed`,
`integration_added` / `_updated` / `_enabled` / `_disabled`):

- One row per capability: source integration(s) in priority order.
- Reconciliation rules per capability, e.g. `time_entries.overlap_policy =
  day_wins:<slug>` (today's "awork day beats Personio day"), or `merge`.
- Auto-link rules: by email (people, contributors), by name (companies), each
  on/off per integration.

All writes are server actions gated on `admin`, audited with
`integration_changed`, `integration_credential_set`, `binding_changed`.

## Read side and UI

- Report queries (`tracked-hours`, `calendar`, `utilization`, `forecast`,
  `project-monthly`, `project`, `employee`, `awork`, `personio` query files
  and the two API routes) read `time_entry` / `absence` / `planned_booking`
  and apply the `overlap_policy` from `integration_rule`. The calendar's
  "Personio corner number" becomes "secondary-source hours".
- The three link cards (`personio-link-card`, `awork-link-card`,
  `employee-awork-link-card`) collapse into one `ExternalLinkCard` driven by
  `(integration, entity_type, dante entity)`.
- The six record-listing routes (`/api/awork-*`, `/api/personio-projects`,
  `/api/.../awork-links`, `/api/.../personio-links`) collapse into
  `/api/integrations/[slug]/records?type=…` and
  `/api/integrations/links?dante_type=…&dante_id=…`.
- Link server actions collapse into `createExternalLinkAction` /
  `deleteExternalLinkAction`.
- The agent OpenAPI registry re-exposes the new routes.

## Guards, tests, docs

- `scripts/check-awork-readonly.ts` → `check-integration-readonly.ts`: walks
  `lib/integrations/providers/*`, reads each adapter's `writesAllowedIn`,
  fails on any other HTTP write. Stays in `npm run check`.
- `describeAdapter(adapter)` vitest conformance suite: manifest sanity,
  `configSchema` round-trips, every declared capability has a `pull*`, every
  emitted record validates against the canonical zod schema.
- `_template/` provider folder with the conformance test pre-wired.
- `docs/integrations.md`: how to write an adapter in one sitting.

## Phases and order

| # | Phase | Ships as | Risk |
| --- | --- | --- | --- |
| 1 | Canonical data model + migrations + backfills + mirror triggers (**done**, 0023) | Behaviour-neutral | High: employee identity change; do on a DB snapshot first |
| 2 | Adapter extraction (Personio, awork) + core runner + canonical writes + compat views (**done**, 0024) | Behaviour-neutral | High: sync parity; verified by diffing every report-relevant relation across old sync → migration → new sync |
| 3 | SecretStore + write-only credential UI + terraform grants (**done**, 0025) | Feature | Medium: IAM change on web task role |
| 4 | Integrations / bindings / rules settings pages + health check + audit (**done**) | Feature | Low |
| 5 | Read side on canonical tables, generic link card, collapsed routes/actions | Refactor, report by report | Medium: each report has a parity test |
| 6 | Guard, conformance suite, template, contributor docs | Docs / tooling | Low |

Phases 1 and 2 ship together as one release with no visible change. 3 and 4
are independent after that. 5 can go one report at a time. 6 lands with or
right after 2 so contributors never see the half-way state.

Parity check for 1+2: dump a dev DB, run the old sync, snapshot every
`/api/*` report JSON for a fixed month; migrate, run the new sync, diff.
Zero diff is the exit criterion.
