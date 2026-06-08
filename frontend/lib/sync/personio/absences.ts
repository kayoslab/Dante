/** Personio /company/time-offs → absence rows. */
import type { Client } from "pg";

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
  return items.length;
}
