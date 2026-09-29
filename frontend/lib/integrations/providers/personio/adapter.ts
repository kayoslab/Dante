/** Personio adapter — the HRIS.
 *
 * Capabilities: people (v1 /company/employees + v2 employments),
 * absences (v1 /company/time-offs), compensations (v2 /compensations,
 * plus the salary-history walk in `afterSync`), projects (v2 /projects —
 * the dropdown consultants pick when logging time) and time entries
 * (v2 /attendance-periods, delta by `updated_at`).
 *
 * Credentials: Personio's "API credentials" are a client id + client
 * secret exchanged for a rotating bearer token. From the admin's point of
 * view that is an API key pair, so `auth.kind` is `api_key`.
 */
import { z } from "zod";

import { log as logger } from "@/lib/logger";
import type {
  CanonicalEmployee,
  CanonicalProject,
  ProviderAdapter,
  Pulled,
  CanonicalTimeEntry,
} from "@/lib/integrations/core/types";
import { loadPersonioCredentials } from "@/lib/integrations/core/credentials";

import { flattenAbsence } from "./absences";
import { flattenAttendancePeriod, formatUpdatedSince } from "./attendance";
import { PersonioClient } from "./client";
import { backfillSalaryHistory, flattenCompensation, type CompensationRecord } from "./compensations";
import { flattenEmployee, pickEmploymentEndDate } from "./flatten";

const PersonioConfigSchema = z.object({}).passthrough();
type PersonioConfig = z.infer<typeof PersonioConfigSchema>;

type V2Project = {
  id?: string;
  name?: string | null;
  status?: string | null;
  billable?: boolean | null;
  parent_project?: { id?: string | null } | null;
};

export const personioAdapter: ProviderAdapter<PersonioClient, PersonioConfig> = {
  slug: "personio",
  displayName: "Personio",
  docsUrl: "https://developer.personio.de/",
  auth: {
    kind: "api_key",
    fields: [
      { key: "client_id", label: "Client ID", secret: false, required: true },
      { key: "client_secret", label: "Client secret", secret: true, required: true },
    ],
  },
  configSchema: PersonioConfigSchema,
  capabilities: ["people", "absences", "compensations", "projects", "time_entries"],
  writesAllowedIn: ["client.ts"], // POST /auth only — the token exchange

  async createClient() {
    return new PersonioClient(await loadPersonioCredentials());
  },

  async healthCheck(client) {
    try {
      await client.listPersonioProjects();
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },

  async pullEmployees(client): Promise<CanonicalEmployee[]> {
    const employees = await client.listEmployees();
    const out: CanonicalEmployee[] = [];
    for (const emp of employees) {
      const row = flattenEmployee(emp);
      const employee_id = row.employee_id as number | null;
      if (employee_id === null || !Number.isFinite(employee_id)) continue;

      // v2 employments → actual leaving date (v1 only gives
      // contract_end_date for fixed-term contracts). Best-effort.
      let employment_end_date: string | null = null;
      try {
        employment_end_date = pickEmploymentEndDate(await client.getPersonEmployments(employee_id));
      } catch {
        /* keep null on a transient v2 failure */
      }

      const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
      const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
      out.push({
        external_id: String(employee_id),
        first_name: str(row.first_name),
        last_name: str(row.last_name),
        email: str(row.email),
        status: str(row.status),
        department: str(row.department),
        position: str(row.position),
        subcompany: str(row.subcompany),
        office: str(row.office),
        hire_date: str(row.hire_date),
        contract_end_date: str(row.contract_end_date),
        employment_end_date,
        employment_type: str(row.employment_type),
        weekly_working_hours: num(row.weekly_working_hours),
        supervisor_external_id: str(row.supervisor_id),
        fix_salary: num(row.fix_salary),
        fix_salary_interval: str(row.fix_salary_interval),
        hourly_salary: num(row.hourly_salary),
        cost_center: str(row.cost_center),
        gender: str(row.gender),
        probation_period_end: str(row.probation_period_end),
        birth_date: str(row.birth_date),
        nationality: str(row.nationality),
        notice_period_probation: str(row.notice_period_probation),
        absence_entitlement: row.absence_entitlement ?? null,
        raw: emp,
      });
    }
    return out;
  },

  async pullAbsences(client, _ctx, window) {
    const items = await client.listAbsences(window.start_date, window.end_date);
    const out = [];
    for (const item of items) {
      const a = flattenAbsence(item);
      if (a) out.push(a);
    }
    return out;
  },

  async pullCompensations(client) {
    const items = (await client.listCompensations()) as CompensationRecord[];
    const out = [];
    for (const item of items) {
      const c = flattenCompensation(item);
      if (c) out.push(c);
    }
    return out;
  },

  /** v2 /projects has no incremental filter; the full list is small (one
   * row per Personio project), so every pull is a full scan. */
  async pullProjects(client): Promise<Pulled<CanonicalProject>> {
    const items = await client.listPersonioProjects();
    const records: CanonicalProject[] = [];
    for (const item of items) {
      const p = item as V2Project;
      if (!p.id) continue;
      records.push({
        external_id: p.id,
        name: p.name ?? "",
        project_key: null,
        external_company_id: null,
        parent_external_id: p.parent_project?.id ?? null,
        billable: p.billable ?? null,
        // ACTIVE / ARCHIVED enum → boolean; null status stays null.
        active: p.status ? p.status === "ACTIVE" : null,
        status_type: null,
        status_name: p.status ?? null,
        start_date: null,
        due_date: null,
        closed_on: null,
        time_budget_seconds: null,
        description: null,
        extra: {},
        source_updated_at: null,
      });
    }
    return { records, mode: "full" };
  },

  /** Delta by default (`updated_at.gte` since the high-water mark) — catches
   * edits to any day, not just those in a fixed window. Falls back to a
   * full `attribution_date` window pull when there is no watermark yet or
   * when Personio rejects the delta filter. `full` forces the window
   * backfill (manual "Sync" button / reconciliation); deletions are only
   * recovered by a full run. */
  async pullTimeEntries(client, ctx, opts): Promise<Pulled<CanonicalTimeEntry>> {
    const fullWindow = () =>
      client.listAttendancePeriods({
        attribution_from: opts.window.start_date,
        attribution_to: opts.window.end_date,
      });
    let items: unknown[];
    let mode: "full" | "incremental" = "full";
    if (opts.full) {
      items = await fullWindow();
    } else {
      const hwm = await ctx.highWaterMark("time_entries");
      if (hwm) {
        try {
          items = await client.listAttendancePeriods({ updated_since: formatUpdatedSince(hwm) });
          mode = "incremental";
        } catch (e) {
          logger.warn("personio_attendance_delta_fallback", {
            issue: e instanceof Error ? e.message : String(e),
          });
          items = await fullWindow();
        }
      } else {
        items = await fullWindow();
      }
    }
    const records: CanonicalTimeEntry[] = [];
    for (const item of items) {
      const t = flattenAttendancePeriod(item);
      if (t) records.push(t);
    }
    return { records, mode };
  },

  async afterSync(client, ctx) {
    const n = await backfillSalaryHistory(ctx.conn, client, ctx.integration.slug);
    if (n > 0) ctx.log(`  salary history: ${n} new change event(s) captured`);
  },
};
