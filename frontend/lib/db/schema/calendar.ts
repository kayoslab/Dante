import { date, pgTable, primaryKey, text, varchar } from "drizzle-orm/pg-core";

/** German public holidays per state — 'DE' is the federal set, the 16
 * state codes carry federal + state-specific days. Seeded 2024–2030 by
 * migration 0022 from the same `date-holidays` source the TS engines use
 * (lib/db/_de-holidays.ts), so SQL-side and TS-side calendars agree.
 * Working day = Mon–Fri AND no row here for the employee's state.
 * Re-seed before 2031. */
export const stateHoliday = pgTable(
  "state_holiday",
  {
    state: varchar("state", { length: 2 }).notNull(),
    day: date("day").notNull(),
    name: text("name"),
  },
  (t) => [primaryKey({ name: "state_holiday_pk", columns: [t.state, t.day] })],
);
