/** Query backing the `/api/inspect/[employee_id]` route — the raw
 * Personio snapshot used by managers to debug "why is this attribute
 * missing / wrong for X". The route then flattens + redacts the payload
 * (bank, tax, government-ID and free-text fields) before shipping it;
 * the redaction is an APP-LEVEL concern and lives in the route, not here. */
import { sql } from "drizzle-orm";

import { db } from "../client";

export type RawEmployeeSnapshot = {
  sync_run_id: number;
  started_at: Date | string | null;
  payload: unknown;
};

/** Latest raw Personio snapshot for an employee, or null when no
 * snapshot row exists. `null` does NOT distinguish "no employee" from
 * "no snapshot for employee"; use `employeeExists` after a null to
 * pick the right 404 message. */
export async function getLatestRawEmployeeSnapshot(
  employee_id: number,
): Promise<RawEmployeeSnapshot | null> {
  const r = await db.execute(sql`
    SELECT s.sync_run_id, sr.started_at, s.payload
    FROM raw_employee_snapshot s
    LEFT JOIN sync_run sr ON sr.sync_run_id = s.sync_run_id
    WHERE s.employee_id = ${employee_id}
    ORDER BY sr.started_at DESC NULLS LAST
    LIMIT 1
  `);
  const row = (r.rows as Array<Record<string, unknown>>)[0];
  if (!row) return null;
  return {
    sync_run_id: row.sync_run_id as number,
    started_at: (row.started_at as Date | string | null) ?? null,
    payload: row.payload,
  };
}

/** Does this employee exist in `employee_current`? Used by the inspect
 * route to differentiate "employee not found" from "no snapshot yet". */
export async function employeeExists(employee_id: number): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM employee_current WHERE employee_id = ${employee_id}
  `);
  return (r.rows as unknown[]).length > 0;
}
