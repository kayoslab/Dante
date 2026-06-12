/** Top-level sync orchestration.
 *
 * Equivalent to `dante sync` — pulls Personio + awork, runs the awork
 * housekeeping passes. Each step prints to stderr (CloudWatch-friendly).
 * Catches per-source HTTP errors so a missing scope on one endpoint
 * doesn't kill the whole run.
 */
import { openSyncConn } from "./db";

import { PersonioClient } from "./personio/client";
import { loadPersonioCredentials } from "./credentials";
import { syncEmployees } from "./personio/employees";
import { syncCompensations } from "./personio/compensations";
import { syncAbsences } from "./personio/absences";
import { syncAttendances } from "./personio/attendance";
import { syncPersonioProjects } from "./personio/personio-projects";

import { aworkClient } from "./awork/client";
import {
  syncAworkCompanies,
  syncAworkUsers,
  rollupAworkPlanningsToAssignments,
  syncAworkProjects,
  syncAworkTimeBookings,
  syncAworkTimeEntries,
  autoLinkAworkUsersByEmail,
  autoLinkAworkCompaniesByName,
  autoLinkAworkFreelancersByEmail,
  rollupAworkHoursToFreelancers,
} from "./awork/sync";
import {
  bulkImportFromAwork,
  applyAworkMoneyToImported,
  backfillImportedProjects,
} from "./awork/housekeeping";

export type SyncOptions = {
  source?: "all" | "personio" | "awork";
  absence_days?: number;
  attendance_days?: number;
  time_entry_days?: number;
  skip_absences?: boolean;
  skip_attendances?: boolean;
  skip_compensations?: boolean;
  skip_time_entries?: boolean;
  skip_awork_maintenance?: boolean;
};

function isoOffset(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** One-liner stringifier for the `err` value in a catch block. Falls
 * back to `String(err)` so a thrown non-Error (number, plain object,
 * undefined) doesn't surface as `[object Object]` in the log. */
function formatSyncError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type SyncLogger = (line: string) => void;

const defaultLogger: SyncLogger = (line) => console.error(line);

export async function runSync(
  opts: SyncOptions = {},
  log: SyncLogger = defaultLogger,
): Promise<void> {
  const source = opts.source ?? "all";
  const want_personio = source === "all" || source === "personio";
  const want_awork = source === "all" || source === "awork";

  const conn = await openSyncConn();
  try {
    if (want_personio) await runPersonioSync(conn, opts, log);
    if (want_awork) {
      if (want_personio) log("");
      await runAworkSync(conn, opts, log);
    }
    // Audit retention: piggyback on the sync schedule so we don't need
    // a separate cron. Non-fatal — a purge failure can't break the sync.
    try {
      const { purgeAuditLog } = await import("./_retention");
      const r = await purgeAuditLog(conn);
      if (r.deleted > 0) {
        log(
          `audit retention: purged ${r.deleted} row(s) older than ${r.retention_days} days (cutoff ${r.cutoff.toISOString().slice(0, 10)})`,
        );
      }
    } catch (err) {
      log(`audit retention: skipped — ${formatSyncError(err)}`);
    }
  } finally {
    await conn.end();
  }
}

async function runPersonioSync(
  conn: Awaited<ReturnType<typeof openSyncConn>>,
  opts: SyncOptions,
  log: SyncLogger,
): Promise<void> {
  log("--- Personio ---");
  const creds = await loadPersonioCredentials();
  const client = new PersonioClient(creds);

  const { sync_run_id, employees_seen } = await syncEmployees(conn, client);
  log(`Sync #${sync_run_id}: ${employees_seen} employees`);

  if (!opts.skip_compensations) {
    try {
      const n = await syncCompensations(conn, client, sync_run_id, log);
      log(`  compensations:        ${n}`);
    } catch (err) {
      log(
        `  compensations: skipped — ${formatSyncError(err)}`,
      );
    }
  }

  const absence_days = opts.absence_days ?? 365;
  if (!opts.skip_absences) {
    const start = isoOffset(-absence_days);
    const end = isoOffset(absence_days);
    try {
      const n = await syncAbsences(conn, client, start, end, sync_run_id);
      log(`  absences  (${start} → ${end}): ${n}`);
    } catch (err) {
      log(`  absences: skipped — ${formatSyncError(err)}`);
    }
  }

  const attendance_days = opts.attendance_days ?? 365;
  if (!opts.skip_attendances) {
    const start = isoOffset(-attendance_days);
    const end = today();
    try {
      const n = await syncAttendances(conn, client, start, end, sync_run_id);
      log(`  attendances (${start} → ${end}): ${n}`);
    } catch (err) {
      log(
        `  attendances: skipped — ${formatSyncError(err)}`,
      );
    }
  }

  try {
    const n = await syncPersonioProjects(conn, client, sync_run_id);
    log(`  personio projects:    ${n}`);
  } catch (err) {
    log(
      `  personio projects: skipped — ${formatSyncError(err)}`,
    );
  }
}

async function runAworkSync(
  conn: Awaited<ReturnType<typeof openSyncConn>>,
  opts: SyncOptions,
  log: SyncLogger,
): Promise<void> {
  log("--- awork ---");

  // sync_run_id for awork is a unix timestamp (no sync_run row — awork's
  // catalog tables track freshness via last_seen_sync_run_id only).
  const sync_run_id = Math.floor(Date.now() / 1000);

  let n = await syncAworkCompanies(conn, aworkClient, sync_run_id);
  log(`  companies:            ${n}`);
  n = await syncAworkUsers(conn, aworkClient, sync_run_id);
  log(`  users:                ${n}`);
  n = await syncAworkProjects(conn, aworkClient, sync_run_id);
  log(`  projects:             ${n}`);

  if (!opts.skip_time_entries) {
    const time_entry_days = opts.time_entry_days ?? 365;
    const start = isoOffset(-time_entry_days);
    const end = today();
    n = await syncAworkTimeEntries(conn, aworkClient, sync_run_id, start, end);
    log(`  time entries (${start} → ${end}): ${n}`);
  }
  // Planner data — what's scheduled looking forward. No date range
  // arg on the endpoint; sync prunes anything that disappears upstream.
  const tb = await syncAworkTimeBookings(conn, aworkClient, sync_run_id);
  log(`  time bookings:        ${tb.upserted} upserted, ${tb.pruned} pruned`);

  // Roll up bookings into `assignment` rows (source = 'awork-planning')
  // so the home portfolio, project economics, and calendar load all
  // pick up the planning data. Full refresh — manual assignments are
  // untouched.
  const plan = await rollupAworkPlanningsToAssignments(conn);
  log(
    `  planning rollup:      deleted ${plan.deleted_previous}, inserted ${plan.inserted}` +
      `, skipped (unlinked user) ${plan.skipped_unlinked_user}` +
      `, skipped (unlinked project) ${plan.skipped_unlinked_project}`,
  );

  const users = await autoLinkAworkUsersByEmail(conn);
  log(
    `  auto-linked ${users.new_links} awork user(s) to employees by email (${users.total} total)`,
  );
  const freelancers = await autoLinkAworkFreelancersByEmail(conn);
  log(
    `  auto-linked ${freelancers.new_links} awork user(s) to freelancers by email (${freelancers.total} total)`,
  );
  const companies = await autoLinkAworkCompaniesByName(conn);
  log(
    `  auto-linked ${companies.new_links} awork company(ies) to customers by name (${companies.total} total)`,
  );

  // Roll up time entries → freelancer_time_entry (source='awork'). Runs
  // after both project + freelancer links are in place so the JOIN can
  // resolve every awork time entry it possibly can.
  if (!opts.skip_time_entries) {
    try {
      const rollup = await rollupAworkHoursToFreelancers(conn);
      log(
        `  freelancer hours rollup: ${rollup.rows_upserted} (assignment, month) row(s) written`,
      );
    } catch (err) {
      log(`  freelancer hours rollup: FAILED — ${formatSyncError(err)}`);
    }
  }

  if (opts.skip_awork_maintenance) {
    log("  (maintenance phase skipped — --skip-awork-maintenance)");
    return;
  }

  log("  --- post-sync housekeeping ---");

  try {
    const s = await bulkImportFromAwork(conn);
    log(
      `  import-all:      auto-linked ${s.auto_linked_companies}, ` +
        `customers +${s.customers_created}/${s.customers_to_create}, ` +
        `projects +${s.projects_created}/${s.projects_to_create}`,
    );
  } catch (err) {
    log(`  import-all:      FAILED — ${formatSyncError(err)}`);
  }
  try {
    const s = await applyAworkMoneyToImported(conn);
    log(
      `  apply-money:     ${s.linked_projects} projects · ` +
        `flipped→FP ${s.billing_model_flipped_to_fp}, ` +
        `agreed ${s.agreed_amount_set}, rates ${s.project_rates_upserted}, ` +
        `budgets ${s.time_budget_set}, notes ${s.notes_extended}`,
    );
  } catch (err) {
    log(`  apply-money:     FAILED — ${formatSyncError(err)}`);
  }
  try {
    const s = await backfillImportedProjects(conn);
    log(
      `  refresh-imported:${s.linked_projects} projects · updated ${s.updated} (fill-NULL-only)`,
    );
  } catch (err) {
    log(
      `  refresh-imported:FAILED — ${formatSyncError(err)}`,
    );
  }
  // `deriveAssignmentsFromAwork` + `closeStaleDerivedAssignments` were
  // retired in commit history — they synthesized assignment rows from
  // awork time entries (allocation = total_hours / working_days / 8h),
  // which manufactured open-ended planned allocations for users who
  // weren't actually planned for any further work. The proper source —
  // awork's own planning data via `/users/workload` — flows in via a
  // separate sync stage; see syncAworkPlannings below.
}
