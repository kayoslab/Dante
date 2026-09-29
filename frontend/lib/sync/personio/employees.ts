/** syncEmployees.
 *
 * Flow:
 *  1. INSERT a sync_run row (autocommit) so external observers see "running"
 *     before the per-employee loop starts.
 *  2. For each employee:
 *      - fetch v2 employments → derive employment_end_date (best-effort,
 *        tolerates v2 transient failures)
 *      - BEGIN per-employee transaction
 *      - INSERT raw_employee_snapshot
 *      - UPSERT employee_current (Drizzle-typed: schema drift surfaces at
 *        compile time, not when the next sync runs in production)
 *      - COMMIT per-employee transaction (so a single bad record can't
 *        poison the whole sync)
 *  3. UPDATE sync_run to completed.
 *  4. On any error: UPDATE sync_run to failed and rethrow.
 */
import { sql } from "drizzle-orm";
import type { Client } from "pg";

import { employeeCurrent, rawEmployeeSnapshot, syncRun } from "@/lib/db/schema";

import { syncDrizzle } from "../db";
import { excludedSet } from "../_upsert";
import type { PersonioClient } from "./client";
import { EMPLOYEE_COLUMNS, type EmployeeColumn } from "./attribute-map";
import { flattenEmployee, pickEmploymentEndDate } from "./flatten";

export type SyncEmployeesResult = {
  sync_run_id: number;
  employees_seen: number;
};

type EmployeeCurrentInsert = typeof employeeCurrent.$inferInsert;

export async function syncEmployees(
  conn: Client,
  client: PersonioClient,
): Promise<SyncEmployeesResult> {
  const db = syncDrizzle(conn);
  const started_at = new Date();

  const [runRow] = await db
    .insert(syncRun)
    .values({ started_at, status: "running" })
    .returning({ sync_run_id: syncRun.sync_run_id });
  const sync_run_id = runRow.sync_run_id;

  try {
    const employees = await client.listEmployees();

    for (const emp of employees) {
      const row = flattenEmployee(emp);
      const employee_id = row.employee_id as number | null;
      if (employee_id === null) continue;

      // Best-effort: an outage on v2 shouldn't break the v1 sync.
      try {
        const employments = await client.getPersonEmployments(employee_id);
        row.employment_end_date = pickEmploymentEndDate(employments);
      } catch {
        /* keep existing employment_end_date from v1 (already null) */
      }

      await conn.query("BEGIN");
      try {
        await db.insert(rawEmployeeSnapshot).values({
          sync_run_id,
          employee_id,
          payload: emp as Record<string, unknown>,
        });

        // Build the typed insert value object from the flattened row.
        // `EMPLOYEE_COLUMNS` is the authoritative list of columns the
        // sync owns; Drizzle's $inferInsert ensures we don't drift.
        const values = buildEmployeeCurrentInsert(row, sync_run_id, new Date());

        // ON CONFLICT (employee_id) DO UPDATE — set every owned column to
        // the EXCLUDED value. The list is derived from EMPLOYEE_COLUMNS so
        // adding a new column needs exactly one change (the schema).
        const updateSet = excludedSet([
          ...EMPLOYEE_COLUMNS.filter((c) => c !== "employee_id"),
          "last_seen_sync_run_id",
          "last_updated_at",
        ] as const);

        await db
          .insert(employeeCurrent)
          .values(values)
          .onConflictDoUpdate({
            target: employeeCurrent.employee_id,
            set: updateSet,
          });

        await conn.query("COMMIT");
      } catch (err) {
        await conn.query("ROLLBACK");
        throw err;
      }
    }

    // employee_id is a Dante-owned identity since migration 0023, but this
    // sync still inserts Personio's ids explicitly. Explicit inserts don't
    // advance the sequence, so push it past the highest id we just wrote —
    // otherwise a later generated id (a non-Personio HRIS, phase 2) could
    // collide with a Personio id that arrived after the migration.
    await bumpEmployeeIdSequence(conn);

    await db
      .update(syncRun)
      .set({ completed_at: new Date(), employees_seen: employees.length, status: "completed" })
      .where(sql`${syncRun.sync_run_id} = ${sync_run_id}`);

    return { sync_run_id, employees_seen: employees.length };
  } catch (err) {
    await db
      .update(syncRun)
      .set({
        completed_at: new Date(),
        status: "failed",
        notes: err instanceof Error ? err.message : String(err),
      })
      .where(sql`${syncRun.sync_run_id} = ${sync_run_id}`);
    throw err;
  }
}

/** Advance the employee_current.employee_id identity sequence past the
 * highest id currently in the table. Idempotent; safe to call after any
 * batch of explicit-id inserts. `false` = "not yet called", so the next
 * generated id is exactly max + 1. */
export async function bumpEmployeeIdSequence(conn: Client): Promise<void> {
  await conn.query(`
    SELECT setval(
      pg_get_serial_sequence('employee_current', 'employee_id'),
      COALESCE((SELECT MAX(employee_id) FROM employee_current), 0) + 1,
      false
    )
  `);
}

function buildEmployeeCurrentInsert(
  row: Record<string, unknown>,
  sync_run_id: number,
  now: Date,
): EmployeeCurrentInsert {
  const insert: Record<string, unknown> = {
    last_seen_sync_run_id: sync_run_id,
    last_updated_at: now,
  };
  for (const col of EMPLOYEE_COLUMNS) {
    insert[col] = row[col as EmployeeColumn] ?? null;
  }
  return insert as EmployeeCurrentInsert;
}

