/** Personio /company/time-offs → absence rows. */
import type { Client } from "pg";
import { and, gte, lte, lt } from "drizzle-orm";

import { absence } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { PersonioClient } from "./client";
import {
  coerceDate,
  coerceNumber,
  envelopeEmployeeId,
} from "./_helpers";

const ABSENCE_COLUMNS = [
  "absence_id",
  "employee_id",
  "time_off_type",
  "start_date",
  "end_date",
  "half_day_start",
  "half_day_end",
  "days_count",
  "status",
  "comment",
] as const;

function flattenAbsence(item: unknown): Record<string, unknown> {
  const attrs =
    (item as { attributes?: Record<string, unknown> }).attributes ?? {};
  const typeObj = attrs.time_off_type as
    | { attributes?: { name?: string } }
    | undefined;
  const typeName = typeObj?.attributes?.name ?? null;

  const half = (v: unknown): boolean | null =>
    v === null || v === undefined ? null : Boolean(v);

  return {
    absence_id: attrs.id ?? null,
    employee_id: envelopeEmployeeId(attrs.employee),
    time_off_type: typeName,
    start_date: coerceDate(attrs.start_date),
    end_date: coerceDate(attrs.end_date),
    half_day_start: half(attrs.half_day_start),
    half_day_end: half(attrs.half_day_end),
    days_count: coerceNumber(attrs.days_count),
    status: attrs.status ?? null,
    comment: attrs.comment || null,
  };
}

export async function syncAbsences(
  conn: Client,
  client: PersonioClient,
  start_date: string,
  end_date: string,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listAbsences(start_date, end_date);
  const set = excludedSet([
    ...ABSENCE_COLUMNS.filter((c) => c !== "absence_id"),
    "last_seen_sync_run_id",
  ] as const);
  for (const item of items) {
    const row = flattenAbsence(item);
    if (row.absence_id === null || row.employee_id === null) continue;
    const insert: Record<string, unknown> = {
      last_seen_sync_run_id: sync_run_id,
    };
    for (const c of ABSENCE_COLUMNS) {
      insert[c] = row[c];
    }
    await db
      .insert(absence)
      .values(insert as typeof absence.$inferInsert)
      .onConflictDoUpdate({
        target: absence.absence_id,
        set,
      });
  }

  // Cleanup: rows whose date window overlaps the synced range AND that
  // weren't refreshed by this run no longer exist in Personio (withdrawn,
  // declined, deleted). The upsert above never removes them, which is
  // how stale rows like Ina Clima's June-10 Überstundenausgleich linger
  // in Dante even after Personio drops them. Scope strictly to the
  // synced window so a partial sync of, say, "2026-06-01 → 2026-06-15"
  // can never wipe out absences in other date ranges.
  const deleted = await db
    .delete(absence)
    .where(
      and(
        lt(absence.last_seen_sync_run_id, sync_run_id),
        lte(absence.start_date, end_date),
        gte(absence.end_date, start_date),
      ),
    )
    .returning({ id: absence.absence_id });
  if (deleted.length > 0) {
    // Log here keeps the run summary informative even when nothing else
    // dramatic happens this run. Use console.warn so it surfaces above
    // the typical info-level upsert chatter without needing structured logs.
    console.warn(
      `personio absences: removed ${deleted.length} stale row(s) (window ${start_date}→${end_date})`,
    );
  }

  return items.length;
}
