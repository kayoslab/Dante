/** awork adapter — the delivery / time-tracking tool.
 *
 * Capabilities: external_contributors (/users), companies (/companies),
 * projects (/projects + the money custom fields), time_entries
 * (/timeentries by date window) and planned_bookings (/timebookings, the
 * Planner). Companies and projects pull incrementally by `updatedOn`
 * unless a full scan is forced.
 *
 * Read-only on the awork side: the data client is GET-only and the only
 * POST lives in `auth.ts` (OAuth token endpoint). Enforced by
 * `scripts/check-integration-readonly.ts` through `writesAllowedIn`.
 */
import { z } from "zod";

import { log as logger } from "@/lib/logger";
import type {
  CanonicalBooking,
  CanonicalCompany,
  CanonicalPerson,
  CanonicalProject,
  CanonicalTimeEntry,
  ProviderAdapter,
  PullContext,
  Pulled,
} from "@/lib/integrations/core/types";

import { getValidAccessToken } from "./auth";
import { aworkClient, type AworkClient } from "./client";
import { aworkUserStatus, type AworkCustomFieldValue, type AworkProject } from "./schemas";

export const AworkConfigSchema = z
  .object({
    oauth_scope: z
      .string()
      .min(1)
      .describe(
        "OAuth scope requested at authorization. awork's default for a read-only integration is offline_access.",
      )
      .default("offline_access"),
  })
  .passthrough();
export type AworkConfig = z.infer<typeof AworkConfigSchema>;

const TOKEN_URL = "https://api.awork.com/api/v1/accounts/token";
const AUTHORIZE_URL = "https://api.awork.com/api/v1/accounts/authorize";

function dateOnly(iso: unknown): string | null {
  if (!iso) return null;
  const s = String(iso);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function toDate(iso: unknown): Date | null {
  if (!iso) return null;
  const d = new Date(String(iso));
  return isNaN(d.getTime()) ? null : d;
}

function emailFromContactInfos(
  infos: Array<{ type?: string | null; subType?: string | null; value?: string | null }> | null | undefined,
): string | null {
  if (!infos) return null;
  const workEmail = infos.find((c) => c.type === "email" && c.subType === "work")?.value;
  if (workEmail) return workEmail;
  return infos.find((c) => c.type === "email")?.value ?? null;
}

/** Bare OData datetime literal body (`YYYY-MM-DDTHH:MM:SS`, no ms / no `Z`)
 * for awork's `filterby`. */
function formatUpdatedSince(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "");
}

/** Pull a catalog incrementally (rows whose `updatedOn` is at/after our
 * high-water mark) or in full. Falls back to a full pull when there is no
 * watermark yet or when awork rejects the delta filter, so an unsupported
 * `filterby` degrades to a correct (if slower) full sync, logged. */
async function pullCatalog<T>(
  ctx: PullContext,
  capability: "companies" | "projects",
  full: boolean,
  list: (opts?: { updated_since?: string | null }) => Promise<T[]>,
): Promise<{ items: T[]; mode: "full" | "incremental" }> {
  if (!full) {
    const hwm = await ctx.highWaterMark(capability);
    if (hwm) {
      try {
        return { items: await list({ updated_since: formatUpdatedSince(hwm) }), mode: "incremental" };
      } catch (e) {
        logger.warn("awork_delta_fallback", {
          resource: capability,
          issue: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
  return { items: await list(), mode: "full" };
}

type MoneyFieldIds = { daily_rate: string | null; fixed_price: string | null; order_number: string | null };

async function resolveMoneyFieldIds(client: AworkClient): Promise<MoneyFieldIds> {
  const defs = await client.listCustomFieldDefinitions();
  const byName = new Map<string, string>();
  for (const d of defs) if (d.name) byName.set(d.name, d.id);
  return {
    daily_rate: byName.get("Daily Rate") ?? null,
    fixed_price: byName.get("Fixed Price") ?? null,
    order_number: byName.get("Order Number") ?? null,
  };
}

function extractCustomFieldValues(
  item: AworkProject,
  ids: MoneyFieldIds,
): { daily_rate: number | null; fixed_price: number | null; order_number: string | null } {
  if (!item.customFields) return { daily_rate: null, fixed_price: null, order_number: null };
  const byId = new Map<string, AworkCustomFieldValue>();
  for (const cf of item.customFields) {
    if (cf.customFieldDefinitionId) byId.set(cf.customFieldDefinitionId, cf);
  }
  const num = (id: string | null): number | null => {
    if (!id) return null;
    const cf = byId.get(id);
    if (!cf || cf.numberValue === null || cf.numberValue === undefined) return null;
    return Number.isFinite(cf.numberValue) ? cf.numberValue : null;
  };
  const text = (id: string | null): string | null => {
    if (!id) return null;
    const cf = byId.get(id);
    return cf?.textValue ?? cf?.stringValue ?? null;
  };
  return {
    daily_rate: num(ids.daily_rate),
    fixed_price: num(ids.fixed_price),
    order_number: text(ids.order_number),
  };
}

export const aworkAdapter: ProviderAdapter<AworkClient, AworkConfig> = {
  slug: "awork",
  displayName: "awork",
  docsUrl: "https://developers.awork.com/",
  auth: {
    kind: "oauth2_pkce",
    fields: [
      { key: "client_id", label: "OAuth client ID", secret: false, required: true },
      { key: "client_secret", label: "OAuth client secret (confidential clients only)", secret: true },
    ],
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    scope: AworkConfigSchema.parse({}).oauth_scope,
  },
  configSchema: AworkConfigSchema,
  capabilities: ["external_contributors", "companies", "projects", "time_entries", "planned_bookings"],
  writesAllowedIn: ["auth.ts"],

  async createClient({ config }) {
    // The OAuth scope is read at authorization time by the /auth/awork/start
    // route (from the integration row); the data client needs nothing from
    // config today.
    void config;
    return aworkClient;
  },

  async healthCheck() {
    try {
      await getValidAccessToken();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async pullPersons(client): Promise<CanonicalPerson[]> {
    const items = await client.listUsers();
    return items.map((item) => ({
      external_id: item.id,
      first_name: item.firstName ?? null,
      last_name: item.lastName ?? null,
      email: emailFromContactInfos(item.userContactInfos),
      status: aworkUserStatus(item.status),
      is_active: !(item.isArchived ?? false) && !(item.isDeactivated ?? false),
      is_external: item.isExternal ?? null,
      extra: {
        position: item.position ?? null,
        title: item.title ?? null,
        is_agent: item.isAgent ?? null,
        is_archived: item.isArchived ?? null,
        is_deactivated: item.isDeactivated ?? null,
        created_on: item.createdOn ?? null,
      },
      source_updated_at: null,
    }));
  },

  async pullCompanies(client, ctx, opts): Promise<Pulled<CanonicalCompany>> {
    const { items, mode } = await pullCatalog(ctx, "companies", opts.full, (o) => client.listClients(o));
    return {
      mode,
      records: items.map((item) => ({
        external_id: item.id,
        name: item.name ?? null,
        is_external: item.isExternal ?? null,
        extra: {
          projects_count: item.projectsCount ?? null,
          projects_in_progress_count: item.projectsInProgressCount ?? null,
          created_on: item.createdOn ?? null,
        },
        source_updated_at: toDate(item.updatedOn),
      })),
    };
  },

  async pullProjects(client, ctx, opts): Promise<Pulled<CanonicalProject>> {
    const { items, mode } = await pullCatalog(ctx, "projects", opts.full, (o) => client.listProjects(o));
    let fieldIds: MoneyFieldIds;
    try {
      fieldIds = await resolveMoneyFieldIds(client);
    } catch {
      fieldIds = { daily_rate: null, fixed_price: null, order_number: null };
    }
    return {
      mode,
      records: items.map((item) => {
        const money = extractCustomFieldValues(item, fieldIds);
        const status_type = item.projectStatus?.type ?? null;
        return {
          external_id: item.id,
          name: item.name ?? null,
          project_key: item.projectKey ?? null,
          external_company_id: item.companyId ?? null,
          parent_external_id: null,
          billable: item.isBillableByDefault ?? null,
          active: status_type === null ? null : status_type !== "closed" && status_type !== "archived",
          status_type,
          status_name: item.projectStatus?.name ?? null,
          start_date: dateOnly(item.startDate),
          due_date: dateOnly(item.dueDate),
          closed_on: dateOnly(item.closedOn),
          time_budget_seconds: item.timeBudget ?? null,
          description: item.description ?? null,
          extra: {
            is_external: item.isExternal ?? null,
            is_private: item.isPrivate ?? null,
            is_retainer: item.isRetainer ?? null,
            project_status_id: item.projectStatusId ?? null,
            tasks_count: item.tasksCount ?? null,
            tasks_done_count: item.tasksDoneCount ?? null,
            created_on: item.createdOn ?? null,
            daily_rate_eur: money.daily_rate !== null ? String(money.daily_rate) : null,
            fixed_price_eur: money.fixed_price !== null ? String(money.fixed_price) : null,
            order_number: money.order_number,
          },
          source_updated_at: toDate(item.updatedOn),
        };
      }),
    };
  },

  /** /timeentries is windowed by date, never delta — every pull is a full
   * window scan (idempotent upsert; nothing is pruned). */
  async pullTimeEntries(client, _ctx, opts): Promise<Pulled<CanonicalTimeEntry>> {
    const items = await client.listTimeEntries({
      start_date: opts.window.start_date,
      end_date: opts.window.end_date,
    });
    const records: CanonicalTimeEntry[] = [];
    for (const item of items) {
      const work_date = dateOnly(item.startDateLocal ?? item.startDateUtc);
      if (!work_date) continue;
      const duration_seconds = item.duration ?? 0;
      records.push({
        external_id: item.id,
        external_person_id: item.userId ?? null,
        external_project_id: item.projectId ?? null,
        external_task_id: item.taskId ?? null,
        work_date,
        start_at: toDate(item.startDateUtc),
        end_at: toDate(item.endDateUtc),
        duration_minutes: Math.floor(duration_seconds / 60),
        is_billable: item.isBillable ?? null,
        is_billed: item.isBilled ?? null,
        status: null,
        note: item.note ?? null,
        type_of_work: item.typeOfWork?.name ?? null,
        extra: {
          duration_seconds,
          type_of_work_id: item.typeOfWork?.id ?? null,
        },
        source_updated_at: null,
      });
    }
    return { records, mode: "full" };
  },

  /** The Planner endpoint is unfiltered, so this is always the full list.
   * Absence-style bookings (no project) are dropped — Personio's absence
   * feed already covers those. */
  async pullPlannedBookings(client): Promise<CanonicalBooking[]> {
    const items = await client.listTimeBookings();
    const out: CanonicalBooking[] = [];
    for (const item of items) {
      if (!item.projectId) continue;
      out.push({
        external_id: item.id,
        external_person_id: item.userId,
        external_project_id: item.projectId,
        start_date: item.startDate,
        end_date: item.endDate,
        duration_seconds: item.duration,
        description: item.description ?? null,
        extra: { lane_order: item.laneOrder ?? null },
        source_created_at: toDate(item.createdOn),
        source_updated_at: toDate(item.updatedOn),
      });
    }
    return out;
  },

  async afterSync(_client, ctx) {
    const policy = ctx.rules.get("projects.import_policy");
    const wanted = policy?.integration === ctx.integration.slug && policy?.apply_money !== false;
    if (!wanted) return;
    const { applyAworkMoneyToImported } = await import("./money");
    const s = await applyAworkMoneyToImported(ctx.conn, ctx.integration.slug);
    ctx.log(
      `  apply-money:     ${s.linked_projects} projects · ` +
        `flipped→FP ${s.billing_model_flipped_to_fp}, ` +
        `agreed ${s.agreed_amount_set}, rates ${s.project_rates_upserted}, ` +
        `budgets ${s.time_budget_set}, notes ${s.notes_extended}`,
    );
  },
};
