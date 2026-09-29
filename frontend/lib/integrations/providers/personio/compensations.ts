/** Personio v2 /compensations → canonical compensations, plus the
 * walk-backward salary history backfill that runs in `afterSync`.
 *
 * Snapshot:
 *   GET /v2/compensations → every comp component active today.
 *
 * Walk-backward (the interesting bit, Personio-specific because it probes
 * the API with `as_of` dates):
 *   For each (employee, legal_entity) with a current FIXED_SALARY component,
 *   walk backward one day at a time via /v2/compensations?as_of=YYYY-MM-DD
 *   looking for the previous distinct effective_from. Each transition
 *   produces a salary_change_event row (idempotent via the
 *   uq_salary_event UNIQUE constraint on (employee, effective, new_annual)).
 *
 * Bounded by max(today − lookback_years, employee.hire_date) so we never
 * probe before the employee existed. Hop cap: MAX_SALARY_HISTORY_HOPS.
 */
import type { Client } from "pg";

import { salaryChangeEvent } from "@/lib/db/schema";
import type { CanonicalCompensation } from "@/lib/integrations/core/types";
import { syncDrizzle } from "@/lib/sync/db";

import type { PersonioClient } from "./client";
import { coerceDate, coerceNumber } from "./helpers";

export type CompensationRecord = {
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

export function flattenCompensation(item: CompensationRecord): CanonicalCompensation | null {
  if (!item.id || !item.person?.id) return null;
  const amount = item.amount ?? {};
  const type_ = item.type ?? {};
  const legal_entity = item.legal_entity ?? {};
  return {
    external_id: String(item.id),
    external_person_id: String(item.person.id),
    effective_from: coerceDate(item.effective_from),
    amount_value: coerceNumber(amount.value),
    amount_currency: amount.currency ?? null,
    interval: item.interval ?? null,
    category: type_.category ?? null,
    type_name: type_.name ?? null,
    legal_entity_id: legal_entity.id ? String(legal_entity.id) : null,
    weekly_working_hours: coerceNumber(item.weekly_working_hours),
    full_time_weekly_working_hours: coerceNumber(item.full_time_weekly_working_hours),
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

/** Hard ceiling on backward walk steps per (employee, legal_entity).
 * A salary changes on calendar-quarter boundaries at most, so 40 hops
 * covers ~10 years even if every quarter saw a change. */
const MAX_SALARY_HISTORY_HOPS = 40;

/** Returns the number of new salary_change_event rows captured. Reads the
 * current FIXED_SALARY rows this integration wrote to compensation_event. */
export async function backfillSalaryHistory(
  conn: Client,
  client: PersonioClient,
  slug: string,
  lookback_years = 5,
): Promise<number> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const lookbackCutoff = new Date(today);
  lookbackCutoff.setUTCFullYear(today.getUTCFullYear() - lookback_years);

  const currentRes = await conn.query<{
    employee_id: number;
    external_person_id: string;
    legal_entity_id: string | null;
    effective_from: string | Date | null;
    amount_value: string | number | null;
    amount_currency: string | null;
    interval: string | null;
    hire_date: string | Date | null;
  }>(
    `SELECT ce.employee_id, l.external_id AS external_person_id,
            ce.legal_entity_id, ce.effective_from,
            ce.amount_value, ce.amount_currency, ce.interval,
            ec.hire_date
       FROM compensation_event ce
       LEFT JOIN employee_current ec ON ec.employee_id = ce.employee_id
       LEFT JOIN external_link l
         ON l.integration_slug = ce.integration_slug
        AND l.entity_type = 'person'
        AND l.dante_type = 'employee'
        AND l.dante_id = ce.employee_id
      WHERE ce.integration_slug = $1
        AND ce.category = 'FIXED_SALARY' AND ce.effective_from IS NOT NULL`,
    [slug],
  );

  // Cache probe responses — many employees share the same probe date
  // (e.g. the day before a calendar-quarter raise).
  const probeCache = new Map<string, CompensationRecord[]>();
  const itemsAt = async (date: Date): Promise<CompensationRecord[]> => {
    const key = isoDay(date);
    let cached = probeCache.get(key);
    if (cached === undefined) {
      cached = (await client.listCompensations({ as_of: key })) as CompensationRecord[];
      probeCache.set(key, cached);
    }
    return cached;
  };

  const db = syncDrizzle(conn);
  let nNew = 0;
  for (const r of currentRes.rows) {
    const annual = annualEUR(r.amount_value, r.amount_currency, r.interval);
    if (annual === null) continue;
    let eff = parseISODate(r.effective_from);
    if (eff === null) continue;
    const hire = parseISODate(r.hire_date);
    let bound = lookbackCutoff;
    if (hire && hire > bound) bound = hire;
    // The person id in Personio is what `as_of` probes report; fall back
    // to the Dante id for rows that predate links (they are equal).
    const personId = r.external_person_id ?? String(r.employee_id);

    let currentAnnual = annual;
    for (let hop = 0; hop < MAX_SALARY_HISTORY_HOPS; hop++) {
      if (eff <= bound) break;
      const probeItems = await itemsAt(shiftDays(eff, -1));
      let earlier: CompensationRecord | null = null;
      for (const it of probeItems) {
        if (it.type?.category !== "FIXED_SALARY") continue;
        if (String(it.person?.id) !== personId) continue;
        if (r.legal_entity_id !== null && String(it.legal_entity?.id) !== String(r.legal_entity_id)) {
          continue;
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
