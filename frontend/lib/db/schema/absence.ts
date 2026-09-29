import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

import { integration } from "./integration";

// Time-off / absence records (canonical; the `absences` capability). The
// sync replaces rows within the synced date window (no soft delete).
export const absence = pgTable(
  "absence",
  {
    // Canonical key since migration 0024: the source integration plus the
    // tool's own id. `absence_id` is the legacy numeric Personio id, kept
    // populated where the external id is numeric; retired in phase 5.
    integration_slug: text()
      .notNull()
      .references(() => integration.slug, { onDelete: "cascade" }),
    external_id: text().notNull(),
    absence_id: bigint({ mode: "number" }),
    employee_id: integer().notNull(),
    time_off_type: text(),
    start_date: date({ mode: "string" }).notNull(),
    end_date: date({ mode: "string" }).notNull(),
    half_day_start: boolean(),
    half_day_end: boolean(),
    days_count: doublePrecision(),
    status: text(),
    comment: text(),
    last_seen_sync_run_id: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.integration_slug, t.external_id] }),
    // Every report engine looks up absences per (employee, date window).
    index("absence_employee_dates_idx").on(
      t.employee_id,
      t.start_date,
      t.end_date,
    ),
  ],
);
