# Writing an integration adapter

Dante pulls people, projects and time from external tools through
**adapters**. An adapter is one folder under
`frontend/lib/integrations/providers/<slug>/` that knows one tool's API and
returns records in Dante's canonical shapes. Everything else — where
credentials are stored, which tool feeds which kind of data, how
overlapping data is reconciled, the reports, the link pickers — is shared
core code driven by the admin's settings. This guide takes you from an
empty folder to a working provider in one sitting.

For the design and its history see [`integration-adapters.md`](integration-adapters.md).

## 1. Copy the template

```
cp -r frontend/lib/integrations/providers/_template frontend/lib/integrations/providers/<slug>
```

The template ships `adapter.ts` (the contract implementation), `client.ts`
(a read-only HTTP client with zod at the boundary) and `adapter.test.ts`
(the conformance suite with a fake client). The folder name is the
provider slug: lower-case, `[a-z][a-z0-9_-]*`.

## 2. Decide what the tool provides

A **capability** is a slice of data Dante knows how to use. The set is
fixed by Dante (`frontend/lib/integrations/core/capabilities.ts`):

| Capability | Records | Pull method |
| --- | --- | --- |
| `people` | employees (the HRIS view; the primary source *creates* employees) | `pullEmployees` |
| `external_contributors` | persons in a delivery tool, linkable to employees or freelancers | `pullPersons` |
| `companies` | customer-side organisations | `pullCompanies` |
| `projects` | projects as the tool sees them | `pullProjects` |
| `absences` | time-off records | `pullAbsences` |
| `compensations` | salary / compensation events | `pullCompensations` |
| `time_entries` | tracked hours | `pullTimeEntries` |
| `planned_bookings` | forward-looking planner entries | `pullPlannedBookings` |

Declare the ones your tool has in `capabilities` and implement exactly
those pull methods. The conformance test fails on any mismatch in either
direction.

## 3. Fill in the manifest

```ts
export const myAdapter: ProviderAdapter<MyClient, MyConfig> = {
  slug: "mytool",
  displayName: "My Tool",
  docsUrl: "https://…",
  auth: { kind: "api_key", fields: [{ key: "api_key", label: "API key", secret: true, required: true }] },
  configSchema: MyConfigSchema,
  capabilities: ["projects", "time_entries"],
  writesAllowedIn: [],
  …
};
```

- **`auth`** describes what an admin enters under Settings → Integrations.
  `api_key` and `client_credentials` render the listed fields (password
  inputs for `secret: true`); `oauth2_pkce` additionally needs
  `authorizeUrl`, `tokenUrl`, `scope` and its own token-endpoint file (see
  the awork provider). Credentials are stored write-only and reach your
  code only through `loadIntegrationCredentials(slug, [required keys])`
  inside `createClient`.
- **`configSchema`** is a zod object of non-secret settings; the settings
  page renders it (string, number, boolean, enum; anything else as JSON).
  It must accept `{}`.
- **`writesAllowedIn`** lists the files in your folder that may issue an
  HTTP write. Dante integrations are read-only; the guard
  (`npm run check:integration-readonly`) fails the build on any POST / PUT /
  PATCH / DELETE outside that list.

## 4. Return canonical records

Each pull method maps the tool's payload to the canonical type in
`frontend/lib/integrations/core/types.ts`. Rules that keep the core simple:

- **Never touch Dante tables.** Return records; the core upserts them,
  prunes what vanished, resolves links and runs the rollups.
- **`external_id` is the tool's own id**, as a string. Person and project
  references on time entries and bookings are external ids *in your own
  integration*; the core resolves them through `external_link`.
- **Report the pull mode.** Catalog pulls (`companies`, `projects`,
  `time_entries`) return `{ records, mode }`. Ask
  `ctx.highWaterMark(capability)` for the newest `source_updated_at` you
  stored and do a delta when the tool supports it; say `full` when you did
  a complete scan — the core archives projects that disappeared only after
  a full pull.
- **Put provider-specific fields into `extra`** (a JSON object). Reports
  never read it, but your `afterSync` hook can (awork keeps its rates and
  fixed-price custom fields there).
- **Dates are `YYYY-MM-DD` strings, instants are `Date`.** `source_updated_at`
  drives delta pulls; leave it `null` if the tool has no such stamp.
- Drop records you cannot map (missing id, unparseable span) rather than
  throwing — one odd row must not abort a sync.

## 5. Optional: `afterSync`

If the tool carries data with no canonical home that should land on Dante
entities (awork's daily rate / fixed price onto imported projects), implement
`afterSync(client, ctx)`. It runs after upserts, links, rollups and the
import policy, receives `ctx.conn` and `ctx.rules`, and is the one place an
adapter may write to Dante tables. Keep it small and idempotent.

## 6. Register and test

1. Add the adapter to `PROVIDERS` in `frontend/lib/integrations/core/registry.ts`.
   The registry must stay side-effect free on import (no env reads, no
   network at module load).
2. Adapt `adapter.test.ts`: give `describeAdapter` a fake client per
   capability. It checks the manifest, the capability ↔ method match, the
   `writesAllowedIn` files, and validates every emitted record against the
   canonical zod schemas (`core/canonical-schemas.ts`).
3. `cd frontend && npm run check` — type-check, both guards, tests.

## 7. Configure it

Everything after that is an admin's job in the UI, no code:

1. Settings → Integrations → **Add integration**: pick your provider, give it
   a slug and a name. It starts disabled.
2. On its page: enter the credentials (write-only), save any settings,
   **Test connection**, then enable it.
3. Settings → Integrations → **Sources & rules**: bind it to the
   capabilities it should feed, in priority order next to the existing
   sources; set the overlap rule, the auto-link rules and the import policy.
4. Run a sync (Settings → Run sync, or the scheduled Lambda). Link cards on
   project, employee and customer pages appear automatically for every
   integration that provides the matching capability.

## What you get for free

- Credential storage in the deployment's secret store (env / AWS Secrets
  Manager / encrypted table), never readable from the UI.
- A health check that runs where the credentials are readable (in the sync
  Lambda in prod).
- Sync orchestration by binding and priority, per-integration failure
  isolation, `last_sync_at` / `last_error` on the integration row.
- Canonical upserts, pruning, auto-linking by e-mail and name, planner →
  assignment and hours → freelancer rollups, customer / project import.
- Reports that read every source through the resolved views and apply the
  admin's overlap rule.
- Link pickers and import tabs on the relevant pages.
- The read-only guard and the conformance suite in CI.
