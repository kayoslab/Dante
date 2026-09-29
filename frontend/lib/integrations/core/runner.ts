/** The sync runner — orchestration by capability binding.
 *
 * Equivalent to `dante sync`. Reads the admin-configured model
 * (`integration`, `integration_binding`, `integration_rule`), then for
 * every capability in dependency order asks each bound integration's
 * adapter to pull, and writes the canonical result through `upsert.ts`.
 * Links, rollups, imports and provider housekeeping follow, all core.
 *
 * Per-integration failures are caught and recorded on the integration
 * row (`last_error`) so one broken tool never blocks the others. Each
 * step prints to the log (CloudWatch-friendly one-liners).
 */
import type { Client } from "pg";

import { openSyncConn } from "@/lib/sync/db";

import { CAPABILITY_ORDER, type Capability } from "./capabilities";
import { loadIntegrationConfig, ruleIntegrations, ruleKey, type IntegrationConfig } from "./config";
import { importCustomers, importProjects, refreshImportedProjects } from "./import";
import { autoLinkCompaniesByName, autoLinkPersonsByEmail } from "./links";
import { getAdapter, type AnyAdapter } from "./registry";
import { purgeAuditLog } from "./retention";
import { rollupHoursToFreelancers, rollupPlannedBookingsToAssignments } from "./rollups";
import type { IntegrationRecord, PullContext, SyncContext, SyncLogger } from "./types";
import {
  archiveUnseenProjects,
  highWaterMark,
  upsertAbsences,
  upsertCompanies,
  upsertCompensations,
  upsertEmployees,
  upsertPersons,
  upsertPlannedBookings,
  upsertProjects,
  upsertTimeEntries,
} from "./upsert";

export type { SyncLogger } from "./types";

export type SyncOptions = {
  /** Integration slugs to run, or "all" (default). A single slug is
   *  accepted for CLI / Lambda compatibility. */
  source?: "all" | string | string[];
  absence_days?: number;
  attendance_days?: number;
  time_entry_days?: number;
  skip_absences?: boolean;
  skip_attendances?: boolean;
  skip_compensations?: boolean;
  skip_time_entries?: boolean;
  /** Skip the post-pull maintenance: import policy, project refresh and
   *  provider `afterSync` hooks. */
  skip_maintenance?: boolean;
  /** @deprecated alias of `skip_maintenance`. */
  skip_awork_maintenance?: boolean;
  /** Force complete catalog scans instead of `updatedOn` deltas
   *  (reconciliation / the manual "Sync" button). */
  awork_full?: boolean;
  /** Force a full time-entry window backfill instead of the delta pull. */
  attendance_full?: boolean;
};

function isoOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatSyncError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

const defaultLogger: SyncLogger = (line) => console.error(line);

type Selected = {
  integration: IntegrationRecord;
  adapter: AnyAdapter;
  client: unknown | null;
  clientError: string | null;
  errors: string[];
};

export async function runSync(
  opts: SyncOptions = {},
  log: SyncLogger = defaultLogger,
): Promise<void> {
  const conn = await openSyncConn();
  try {
    const cfg = await loadIntegrationConfig(conn);
    const selected = selectIntegrations(cfg, opts.source ?? "all", log);
    if (selected.size === 0) {
      log("no enabled integration matches the requested source; nothing to do");
      return;
    }

    const sync_run_id = await openSyncRun(conn);
    log(`Sync #${sync_run_id}: ${[...selected.keys()].join(", ")}`);

    const skip_maintenance = opts.skip_maintenance ?? opts.skip_awork_maintenance ?? false;
    let employees_seen: number | null = null;

    // --- pulls, by capability in dependency order ------------------------
    for (const capability of CAPABILITY_ORDER) {
      if (skipCapability(capability, opts)) continue;
      const bindings = cfg.bindings.get(capability) ?? [];
      for (const b of bindings) {
        const sel = selected.get(b.integration_slug);
        if (!sel) continue;
        const client = await ensureClient(sel, log);
        if (client === null) continue;
        const ctx = pullContext(conn, sel.integration, sync_run_id, log);
        try {
          const seen = await runCapability(conn, capability, sel.adapter, client, ctx, opts, log);
          if (capability === "people" && b.priority === 0 && seen !== null) employees_seen = seen;
        } catch (err) {
          const msg = formatSyncError(err);
          sel.errors.push(`${capability}: ${msg}`);
          log(`  [${sel.integration.slug}] ${capability}: FAILED — ${msg}`);
        }
      }
    }

    // --- links ----------------------------------------------------------
    log("--- links ---");
    for (const slug of ruleIntegrations(cfg.rules.get(ruleKey("people", "auto_link_email")))) {
      if (!selected.has(slug)) continue;
      const r = await autoLinkPersonsByEmail(conn, slug, "employee");
      log(`  [${slug}] auto-linked ${r.new_links} person(s) to employees by email (${r.total} total)`);
    }
    for (const slug of ruleIntegrations(cfg.rules.get(ruleKey("external_contributors", "auto_link_email")))) {
      if (!selected.has(slug)) continue;
      const r = await autoLinkPersonsByEmail(conn, slug, "freelancer");
      log(`  [${slug}] auto-linked ${r.new_links} person(s) to freelancers by email (${r.total} total)`);
    }
    for (const slug of ruleIntegrations(cfg.rules.get(ruleKey("companies", "auto_link_name")))) {
      if (!selected.has(slug)) continue;
      const r = await autoLinkCompaniesByName(conn, slug);
      log(`  [${slug}] auto-linked ${r.new_links} company(ies) to customers by name (${r.total} total)`);
    }

    // --- rollups --------------------------------------------------------
    log("--- rollups ---");
    const plan = await rollupPlannedBookingsToAssignments(conn);
    log(
      `  planning rollup:      deleted ${plan.deleted_previous}, inserted ${plan.inserted}` +
        `, skipped (unlinked user) ${plan.skipped_unlinked_user}` +
        `, skipped (unlinked project) ${plan.skipped_unlinked_project}`,
    );
    if (!opts.skip_time_entries) {
      try {
        const r = await rollupHoursToFreelancers(conn);
        log(`  freelancer hours rollup: ${r.rows_upserted} (assignment, month) row(s) written`);
      } catch (err) {
        log(`  freelancer hours rollup: FAILED — ${formatSyncError(err)}`);
      }
    }

    // --- maintenance: import policy + provider hooks --------------------
    if (skip_maintenance) {
      log("  (maintenance phase skipped)");
    } else {
      log("--- maintenance ---");
      await runImportPolicy(conn, cfg, selected, log);
      for (const sel of selected.values()) {
        if (!sel.adapter.afterSync || sel.client === null) continue;
        try {
          const ctx: SyncContext = {
            ...pullContext(conn, sel.integration, sync_run_id, log),
            conn,
            rules: cfg.rules,
          };
          await sel.adapter.afterSync(sel.client, ctx);
        } catch (err) {
          const msg = formatSyncError(err);
          sel.errors.push(`afterSync: ${msg}`);
          log(`  [${sel.integration.slug}] afterSync: FAILED — ${msg}`);
        }
      }
    }

    // Audit retention piggybacks on the sync schedule. Non-fatal.
    try {
      const r = await purgeAuditLog(conn);
      if (r.deleted > 0) {
        log(
          `audit retention: purged ${r.deleted} row(s) older than ${r.retention_days} days (cutoff ${r.cutoff.toISOString().slice(0, 10)})`,
        );
      }
    } catch (err) {
      log(`audit retention: skipped — ${formatSyncError(err)}`);
    }

    await closeSyncRun(conn, sync_run_id, employees_seen, selected);
    await recordIntegrationStatus(conn, selected);
  } finally {
    await conn.end();
  }
}

// ---------------------------------------------------------------------------

function selectIntegrations(
  cfg: IntegrationConfig,
  source: "all" | string | string[],
  log: SyncLogger,
): Map<string, Selected> {
  const wanted = source === "all" ? null : new Set(Array.isArray(source) ? source : [source]);
  const out = new Map<string, Selected>();
  for (const integration of cfg.integrations.values()) {
    if (!integration.enabled) continue;
    if (wanted && !wanted.has(integration.slug)) continue;
    const adapter = getAdapter(integration.provider);
    if (!adapter) {
      log(`[${integration.slug}] provider "${integration.provider}" is not registered — skipped`);
      continue;
    }
    out.set(integration.slug, { integration, adapter, client: null, clientError: null, errors: [] });
  }
  if (wanted) {
    for (const s of wanted) if (!out.has(s)) log(`source "${s}" is not an enabled integration — ignored`);
  }
  return out;
}

async function ensureClient(sel: Selected, log: SyncLogger): Promise<unknown | null> {
  if (sel.client !== null) return sel.client;
  if (sel.clientError !== null) return null;
  try {
    const config = sel.adapter.configSchema.parse(sel.integration.config);
    sel.client = await sel.adapter.createClient({ integration: sel.integration, config, log });
    return sel.client;
  } catch (err) {
    sel.clientError = formatSyncError(err);
    sel.errors.push(`client: ${sel.clientError}`);
    log(`[${sel.integration.slug}] could not create client — ${sel.clientError}`);
    return null;
  }
}

function pullContext(
  conn: Client,
  integration: IntegrationRecord,
  sync_run_id: number,
  log: SyncLogger,
): PullContext {
  return {
    integration,
    sync_run_id,
    log,
    highWaterMark: (capability) => highWaterMark(conn, integration.slug, capability),
  };
}

function skipCapability(capability: Capability, opts: SyncOptions): boolean {
  if (capability === "absences" && opts.skip_absences) return true;
  if (capability === "compensations" && opts.skip_compensations) return true;
  if (capability === "time_entries" && (opts.skip_time_entries || opts.skip_attendances)) return true;
  return false;
}

/** Run one (capability, integration) pull + upsert. Returns the number of
 * employees seen for `people`, null otherwise. */
async function runCapability(
  conn: Client,
  capability: Capability,
  adapter: AnyAdapter,
  client: unknown,
  ctx: PullContext,
  opts: SyncOptions,
  log: SyncLogger,
): Promise<number | null> {
  const slug = ctx.integration.slug;
  const tag = `  [${slug}]`;
  const full = opts.awork_full ?? false;
  switch (capability) {
    case "people": {
      if (!adapter.pullEmployees) return null;
      const employees = await adapter.pullEmployees(client, ctx);
      const r = await upsertEmployees(conn, slug, ctx.sync_run_id, employees);
      log(`${tag} employees:            ${r.seen} (${r.created} new)`);
      return r.seen;
    }
    case "external_contributors": {
      if (!adapter.pullPersons) return null;
      const n = await upsertPersons(conn, slug, ctx.sync_run_id, await adapter.pullPersons(client, ctx));
      log(`${tag} persons:              ${n}`);
      return null;
    }
    case "companies": {
      if (!adapter.pullCompanies) return null;
      const p = await adapter.pullCompanies(client, ctx, { full });
      const n = await upsertCompanies(conn, slug, ctx.sync_run_id, p.records);
      log(`${tag} companies:            ${n} (${p.mode})`);
      return null;
    }
    case "projects": {
      if (!adapter.pullProjects) return null;
      const p = await adapter.pullProjects(client, ctx, { full });
      const n = await upsertProjects(conn, slug, ctx.sync_run_id, p.records);
      let archived = 0;
      if (p.mode === "full" && n > 0) archived = await archiveUnseenProjects(conn, slug, ctx.sync_run_id);
      log(`${tag} projects:             ${n} (${p.mode})${archived ? `, archived ${archived}` : ""}`);
      return null;
    }
    case "absences": {
      if (!adapter.pullAbsences) return null;
      const days = opts.absence_days ?? 365;
      const window = { start_date: isoOffset(-days), end_date: isoOffset(days) };
      const absences = await adapter.pullAbsences(client, ctx, window);
      const r = await upsertAbsences(conn, slug, ctx.sync_run_id, absences, window);
      log(
        `${tag} absences  (${window.start_date} → ${window.end_date}): ${r.upserted}` +
          `${r.skipped_unlinked ? `, skipped (unlinked) ${r.skipped_unlinked}` : ""}` +
          `${r.pruned ? `, removed stale ${r.pruned}` : ""}`,
      );
      return null;
    }
    case "compensations": {
      if (!adapter.pullCompensations) return null;
      const comps = await adapter.pullCompensations(client, ctx);
      const r = await upsertCompensations(conn, slug, ctx.sync_run_id, comps);
      log(
        `${tag} compensations:        ${r.upserted}` +
          `${r.skipped_unlinked ? `, skipped (unlinked) ${r.skipped_unlinked}` : ""}`,
      );
      return null;
    }
    case "time_entries": {
      if (!adapter.pullTimeEntries) return null;
      const days = opts.time_entry_days ?? opts.attendance_days ?? 365;
      const window = { start_date: isoOffset(-days), end_date: today() };
      const p = await adapter.pullTimeEntries(client, ctx, {
        window,
        full: opts.attendance_full ?? full,
      });
      const n = await upsertTimeEntries(conn, slug, ctx.sync_run_id, p.records);
      const scope = p.mode === "full" ? `${window.start_date} → ${window.end_date}` : "delta";
      log(`${tag} time entries (${scope}): ${n} (${p.mode})`);
      return null;
    }
    case "planned_bookings": {
      if (!adapter.pullPlannedBookings) return null;
      const bookings = await adapter.pullPlannedBookings(client, ctx);
      const r = await upsertPlannedBookings(conn, slug, ctx.sync_run_id, bookings);
      log(`${tag} planned bookings:     ${r.upserted} upserted, ${r.pruned} pruned`);
      return null;
    }
  }
}

async function runImportPolicy(
  conn: Client,
  cfg: IntegrationConfig,
  selected: Map<string, Selected>,
  log: SyncLogger,
): Promise<void> {
  const policy = cfg.rules.get(ruleKey("projects", "import_policy"));
  const slug = typeof policy?.integration === "string" ? policy.integration : null;
  if (!slug || !selected.has(slug)) return;
  const tag = `  [${slug}]`;
  try {
    let customers = { to_create: 0, created: 0 };
    let projects = { to_create: 0, created: 0 };
    if (policy?.customers !== false) customers = await importCustomers(conn, slug);
    if (policy?.projects !== false) projects = await importProjects(conn, slug);
    log(
      `${tag} import:          customers +${customers.created}/${customers.to_create}, ` +
        `projects +${projects.created}/${projects.to_create}`,
    );
  } catch (err) {
    log(`${tag} import:          FAILED — ${formatSyncError(err)}`);
  }
  if (policy?.refresh_dates !== false) {
    try {
      const s = await refreshImportedProjects(conn, slug);
      log(
        `${tag} refresh-imported: ${s.linked_projects} projects · updated ${s.updated} (dates←source; budget/notes fill-NULL-only)`,
      );
    } catch (err) {
      log(`${tag} refresh-imported: FAILED — ${formatSyncError(err)}`);
    }
  }
}

async function openSyncRun(conn: Client): Promise<number> {
  const r = await conn.query<{ sync_run_id: number }>(
    `INSERT INTO sync_run (started_at, status) VALUES (now(), 'running') RETURNING sync_run_id`,
  );
  return r.rows[0].sync_run_id;
}

async function closeSyncRun(
  conn: Client,
  sync_run_id: number,
  employees_seen: number | null,
  selected: Map<string, Selected>,
): Promise<void> {
  const errors = [...selected.values()].flatMap((s) => s.errors.map((e) => `[${s.integration.slug}] ${e}`));
  await conn.query(
    `UPDATE sync_run SET completed_at = now(), employees_seen = $2, status = $3, notes = $4
      WHERE sync_run_id = $1`,
    [
      sync_run_id,
      employees_seen,
      // sync_run.status is constrained to running | completed | failed | partial.
      errors.length === 0 ? "completed" : "partial",
      errors.length === 0 ? null : errors.join("\n"),
    ],
  );
}

async function recordIntegrationStatus(conn: Client, selected: Map<string, Selected>): Promise<void> {
  for (const s of selected.values()) {
    await conn.query(
      `UPDATE integration SET last_sync_at = now(), last_sync_status = $2, last_error = $3, updated_at = now()
        WHERE slug = $1`,
      [
        s.integration.slug,
        s.errors.length === 0 ? "ok" : "error",
        s.errors.length === 0 ? null : s.errors.join("\n"),
      ],
    );
  }
}
