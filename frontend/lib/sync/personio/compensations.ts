/** Personio v2 /compensations + walk-backward salary history backfill.
 *
 * Port of src/dante/sync.py::sync_compensations + _backfill_salary_history.
 *
 * Snapshot:
 *   GET /v2/compensations → every comp component active today, upsert into
 *   compensation_event (PK: compensation_id, stable across syncs).
 *
 * Walk-backward (the interesting bit):
 *   For each (employee, legal_entity) with a current FIXED_SALARY component,
 *   walk backward one day at a time via /v2/compensations?as_of=YYYY-MM-DD
 *   looking for the previous distinct effective_from. Each transition
 *   produces a salary_change_event row (idempotent via the
 *   uq_salary_event UNIQUE constraint on (employee, effective, new_annual)).
 *
 * Bounded by max(today − lookback_years, employee.hire_date) so we never
 * probe before the employee existed. Hop cap: see MAX_SALARY_HISTORY_HOPS.
 */
import { sql } from "drizzle-orm";
import type { Client } from "pg";

import { compensationEvent, salaryChangeEvent } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import type { SyncLogger } from "@/lib/sync/run";
import type { PersonioClient } from "./client";
import { coerceDate, coerceNumber } from "./_helpers";

const COMPENSATION_COLUMNS = [
  "compensation_id",
  "employee_id",
  "effective_from",
  "amount_value",
  "amount_currency",
  "interval",
  "category",
  "type_name",
  "legal_entity_id",
  "weekly_working_hours",
  "full_time_weekly_working_hours",
] as const;

type CompensationRecord = {
  id?: unknown;
  effective_from?: unknown;
  interval?: string;
  amount?: { value?: unknown; currency?: string };
  type?: { category?: string; name?: string };
  person?: { id?: unknown };
  legal_entity?: { id?: unknown };
  weekly_working_hours?: unknown;
  full_time_weekly_working_hours?: unknown;
};

function flattenCompensation(item: CompensationRecord): Record<string, unknown> {
  const amount = item.amount ?? {};
  const type_ = item.type ?? {};
  const person = item.person ?? {};
  const legal_entity = item.legal_entity ?? {};
  return {
    compensation_id: item.id ? String(item.id) : null,
    employee_id: person.id ? Number(person.id) : null,
    effective_from: coerceDate(item.effective_from),
    amount_value: coerceNumber(amount.value),
    amount_currency: amount.currency ?? null,
    interval: item.interval ?? null,
    category: type_.category ?? null,
    type_name: type_.name ?? null,
    legal_entity_id: legal_entity.id ? String(legal_entity.id) : null,
    weekly_working_hours: coerceNumber(item.weekly_working_hours),
    full_time_weekly_working_hours: coerceNumber(
      item.full_time_weekly_working_hours,
    ),
  };
}

/** Normalize (value, currency, interval) → annual EUR. Returns null when
 * currency != EUR or any input is missing. */
function annualEUR(
  amount: unknown,
  currency: string | null | undefined,
  interval: string | null | undefined,
): number | null {
  if (amount === null || amount === undefined) return null;
  if (currency !== "EUR" || !interval) return null;
  const v = Number(amount);
  if (!Number.isFinite(v)) return null;
  if (interval === "YEARLY") return v;
  if (interval === "MONTHLY") return v * 12;
  return null;
}

function parseISODate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const s = String(value).slice(0, 10);
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function shiftDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + days);
  return r;
}

export async function syncCompensations(
  conn: Client,
  client: PersonioClient,
  sync_run_id: number,
  log: SyncLogger,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = (await client.listCompensations()) as CompensationRecord[];
  const now = new Date();
  // Build the ON CONFLICT update set once — every non-PK column maps to
  // `excluded.<col>`. Derived from the column list so a schema change
  // needs exactly one edit.
  const updateSet: Record<string, unknown> = {
    last_seen_sync_run_id: sql`excluded.last_seen_sync_run_id`,
    last_updated_at: sql`excluded.last_updated_at`,
  };
  for (const c of COMPENSATION_COLUMNS) {
    if (c === "compensation_id") continue;
    updateSet[c] = sql.raw(`excluded.${c}`);
  }
  for (const item of items) {
    const row = flattenCompensation(item);
    if (row.compensation_id === null || row.employee_id === null) continue;
    const insert: Record<string, unknown> = {
      last_seen_sync_run_id: sync_run_id,
      last_updated_at: now,
    };
    for (const c of COMPENSATION_COLUMNS) {
      insert[c] = row[c];
    }
    await db
      .insert(compensationEvent)
      .values(insert as typeof compensationEvent.$inferInsert)
      .onConflictDoUpdate({
        target: compensationEvent.compensation_id,
        set: updateSet,
      });
  }
  const nNew = await backfillSalaryHistory(conn, client);
  if (nNew > 0) {
    log(`  salary history: ${nNew} new change event(s) captured`);
  }
  return items.length;
}

/** Hard ceiling on backward walk steps per (employee, legal_entity).
 * A salary changes on calendar-quarter boundaries at most, so 40 hops
 * covers ~10 years even if every quarter saw a change. Stops a runaway
 * loop if `effective_from` data is malformed. */
const MAX_SALARY_HISTORY_HOPS = 40;

async function backfillSalaryHistory(
  conn: Client,
  client: PersonioClient,
  lookback_years = 5,
): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const lookbackCutoff = new Date(today);
  lookbackCutoff.setUTCFullYear(today.getUTCFullYear() - lookback_years);

  const currentRes = await conn.query<{
    employee_id: number;
    legal_entity_id: string | null;
    effective_from: string | Date | null;
    amount_value: string | number | null;
    amount_currency: string | null;
    interval: string | null;
    hire_date: string | Date | null;
  }>(
    `SELECT ce.employee_id, ce.legal_entity_id, ce.effective_from,
            ce.amount_value, ce.amount_currency, ce.interval,
            ec.hire_date
     FROM compensation_event ce
     LEFT JOIN employee_current ec ON ec.employee_id = ce.employee_id
     WHERE ce.category = 'FIXED_SALARY' AND ce.effective_from IS NOT NULL`,
  );

  // Cache probe responses — many employees share the same probe date
  // (e.g. the day before a calendar-quarter raise).
  const probeCache = new Map<string, CompensationRecord[]>();
  const itemsAt = async (date: Date): Promise<CompensationRecord[]> => {
    const key = isoDay(date);
    let cached = probeCache.get(key);
    if (cached === undefined) {
      cached = (await client.listCompensations({
        as_of: key,
      })) as CompensationRecord[];
      probeCache.set(key, cached);
    }
    return cached;
  };

  let nNew = 0;
  for (const r of currentRes.rows) {
    const annual = annualEUR(r.amount_value, r.amount_currency, r.interval);
    if (annual === null) continue;
    let eff = parseISODate(r.effective_from);
    if (eff === null) continue;
    const hire = parseISODate(r.hire_date);
    let bound = lookbackCutoff;
    if (hire && hire > bound) bound = hire;

    let currentAnnual = annual;
    for (let hop = 0; hop < MAX_SALARY_HISTORY_HOPS; hop++) {
      if (eff <= bound) break;
      const probe = shiftDays(eff, -1);
      const probeItems = await itemsAt(probe);
      let earlier: CompensationRecord | null = null;
      for (const it of probeItems) {
        if (it.type?.category !== "FIXED_SALARY") continue;
        if (String(it.person?.id) !== String(r.employee_id)) continue;
        if (r.legal_entity_id !== null) {
          if (String(it.legal_entity?.id) !== String(r.legal_entity_id)) {
            continue;
          }
        }
        earlier = it;
        break;
      }
      if (earlier === null) break; // before employment

      const earlierEff = parseISODate(earlier.effective_from);
      const earlierAnnual = annualEUR(
        earlier.amount?.value,
        earlier.amount?.currency,
        earlier.interval,
      );
      if (earlierEff === null || earlierAnnual === null) break;
      if (earlierEff >= eff) break; // same period — done

      const db = syncDrizzle(conn);
      const ins = await db
        .insert(salaryChangeEvent)
        .values({
          employee_id: r.employee_id,
          effective_date: isoDay(eff),
          old_annual_eur: String(earlierAnnual),
          new_annual_eur: String(currentAnnual),
          source: "personio:sync",
        })
        .onConflictDoNothing()
        .returning({ event_id: salaryChangeEvent.event_id });
      if (ins.length > 0) nNew += 1;

      eff = earlierEff;
      currentAnnual = earlierAnnual;
    }
  }
  return nNew;
}
