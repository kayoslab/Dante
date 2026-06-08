import {
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// One row per `dante sync` invocation. Foreign-keyed by raw_employee_snapshot
// and (last_seen_sync_run_id) by most landing tables.
export const syncRun = pgTable("sync_run", {
  sync_run_id: integer().generatedByDefaultAsIdentity().primaryKey(),
  started_at: timestamp({ mode: "date" }).notNull(),
  completed_at: timestamp({ mode: "date" }),
  employees_seen: integer(),
  status: text().notNull(),
  notes: text(),
});

// Verbatim Personio /v1/employees payload per (sync_run, employee). Kept for
// replay / diff if the upsert logic ever needs to be re-run on historical data.
export const rawEmployeeSnapshot = pgTable(
  "raw_employee_snapshot",
  {
    sync_run_id: integer().notNull(),
    employee_id: integer().notNull(),
    payload: jsonb().notNull(),
  },
  (t) => [primaryKey({ columns: [t.sync_run_id, t.employee_id] })],
);
