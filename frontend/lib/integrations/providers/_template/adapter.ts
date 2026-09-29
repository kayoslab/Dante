/** Template provider — copy this folder to `providers/<slug>/`, rename
 * `exampleAdapter`, and register it in `core/registry.ts`. Everything
 * else (settings pages, credential storage, bindings, sync scheduling,
 * reports, link cards) picks the new provider up from the registry.
 *
 * This example tool provides three capabilities: persons who can be
 * linked to employees or freelancers (`external_contributors`), projects
 * (`projects`) and tracked time (`time_entries`). Delete the ones your tool
 * doesn't have and add the ones it does — the conformance test tells you
 * when a capability and its pull method disagree.
 *
 * The folder name starts with `_` so the read-only guard skips it and the
 * registry never loads it; a real provider folder must not.
 */
import { z } from "zod";

import { loadIntegrationCredentials } from "@/lib/integrations/core/credentials";
import type {
  CanonicalPerson,
  CanonicalProject,
  CanonicalTimeEntry,
  ProviderAdapter,
  Pulled,
} from "@/lib/integrations/core/types";

import { createExampleClient, type ExampleClient } from "./client";

/** Non-secret settings an admin can edit on the integration's page. Rendered
 * from this schema (string / number / boolean / enum fields). */
export const ExampleConfigSchema = z
  .object({
    workspace: z.string().min(1).describe("Workspace identifier shown in the tool's URL.").default("default"),
    include_archived: z.boolean().describe("Also pull archived persons.").default(false),
  })
  .passthrough();
export type ExampleConfig = z.infer<typeof ExampleConfigSchema>;

function dateOnly(v: string | null | undefined): string | null {
  return v && v.length >= 10 ? v.slice(0, 10) : null;
}

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const exampleAdapter: ProviderAdapter<ExampleClient, ExampleConfig> = {
  slug: "example",
  displayName: "Example Tool",
  docsUrl: "https://example.com/api-docs",
  auth: {
    // What the admin enters under Settings → Integrations. `secret: true`
    // renders a password field; the value is stored write-only and read
    // back only by `createClient` through `loadIntegrationCredentials`.
    kind: "api_key",
    fields: [{ key: "api_key", label: "API key", secret: true, required: true }],
  },
  configSchema: ExampleConfigSchema,
  capabilities: ["external_contributors", "projects", "time_entries"],
  // Files in this folder allowed to issue HTTP writes. Empty for a pure
  // API-key tool; an OAuth tool lists its token-endpoint file here.
  writesAllowedIn: [],

  async createClient({ integration }) {
    const creds = await loadIntegrationCredentials(integration.slug, ["api_key"]);
    return createExampleClient(creds.api_key!);
  },

  async healthCheck(client) {
    try {
      await client.listProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async pullPersons(client): Promise<CanonicalPerson[]> {
    const items = await client.listPersons();
    return items.map((p) => ({
      external_id: p.id,
      first_name: p.firstName ?? null,
      last_name: p.lastName ?? null,
      email: p.email ?? null,
      status: p.archived ? "archived" : "active",
      // `active` decides whether link pickers show the person by default.
      is_active: !(p.archived ?? false),
      is_external: null,
      // Anything the core doesn't model goes into `extra`, verbatim.
      extra: {},
      source_updated_at: toDate(p.updatedAt),
    }));
  },

  /** Catalog pull. Use `ctx.highWaterMark("projects")` for a delta when the
   * tool can filter by "updated since"; fall back to a full scan when it
   * can't, and always report which one you did — the core only archives
   * vanished projects after a `full` pull. */
  async pullProjects(client, ctx, opts): Promise<Pulled<CanonicalProject>> {
    let mode: "full" | "incremental" = "full";
    let updated_since: string | null = null;
    if (!opts.full) {
      const hwm = await ctx.highWaterMark("projects");
      if (hwm) {
        updated_since = hwm.toISOString();
        mode = "incremental";
      }
    }
    const items = await client.listProjects({ updated_since });
    return {
      mode,
      records: items.map((p) => ({
        external_id: p.id,
        name: p.name ?? null,
        project_key: null,
        external_company_id: p.clientId ?? null,
        parent_external_id: null,
        billable: p.billable ?? null,
        active: p.status === null || p.status === undefined ? null : p.status !== "closed",
        status_type: p.status ?? null,
        status_name: p.status ?? null,
        start_date: null,
        due_date: null,
        closed_on: null,
        time_budget_seconds: null,
        description: null,
        extra: {},
        source_updated_at: toDate(p.updatedAt),
      })),
    };
  },

  /** Windowed pull. `opts.window` is the date range the runner wants; the
   * core upserts idempotently, so re-pulling a window is always safe. */
  async pullTimeEntries(client, _ctx, opts): Promise<Pulled<CanonicalTimeEntry>> {
    const items = await client.listTimeEntries(opts.window);
    const records: CanonicalTimeEntry[] = [];
    for (const t of items) {
      const work_date = dateOnly(t.date);
      if (!work_date) continue;
      records.push({
        external_id: t.id,
        external_person_id: t.personId ?? null,
        external_project_id: t.projectId ?? null,
        external_task_id: null,
        work_date,
        start_at: null,
        end_at: null,
        duration_minutes: Math.max(0, Math.round(t.minutes)),
        is_billable: null,
        is_billed: null,
        status: null,
        note: t.note ?? null,
        type_of_work: null,
        extra: {},
        source_updated_at: null,
      });
    }
    return { records, mode: "full" };
  },
};
