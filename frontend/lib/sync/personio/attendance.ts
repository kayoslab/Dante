/** Personio /company/attendances → attendance rows. */
import type { Client } from "pg";

import { attendance } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { PersonioClient } from "./client";
import { coerceDate } from "./_helpers";

const ATTENDANCE_COLUMNS = [
  "attendance_id",
  "employee_id",
  "work_date",
  "start_time",
  "end_time",
  "break_minutes",
  "duration_minutes",
  "project_id",
  "comment",
] as const;

function flattenAttendance(item: unknown): Record<string, unknown> {
  const attrs =
    (item as { attributes?: Record<string, unknown> }).attributes ?? {};
  const project = attrs.project as { id?: number } | null | undefined;
  const project_id = project?.id ?? null;

  const start_time = attrs.start_time as string | null | undefined;
  const end_time = attrs.end_time as string | null | undefined;
  const break_minutes = Number(attrs.break ?? 0) || 0;

  let duration_minutes: number | null = null;
  if (
    typeof start_time === "string" &&
    typeof end_time === "string" &&
    start_time.includes(":") &&
    end_time.includes(":")
  ) {
    const [sh, sm] = start_time.split(":").map(Number);
    const [eh, em] = end_time.split(":").map(Number);
    if (
      Number.isFinite(sh) &&
      Number.isFinite(sm) &&
      Number.isFinite(eh) &&
      Number.isFinite(em)
    ) {
      const total = eh * 60 + em - (sh * 60 + sm);
      if (total > 0) duration_minutes = total - break_minutes;
    }
  }

  return {
    attendance_id: (item as { id?: unknown }).id ?? null,
    employee_id: attrs.employee ?? null,
    work_date: coerceDate(attrs.date),
    start_time: start_time ?? null,
    end_time: end_time ?? null,
    break_minutes,
    duration_minutes,
    project_id,
    comment: attrs.comment || null,
  };
}

export async function syncAttendances(
  conn: Client,
  client: PersonioClient,
  start_date: string,
  end_date: string,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listAttendances(start_date, end_date);
  const set = excludedSet([
    ...ATTENDANCE_COLUMNS.filter((c) => c !== "attendance_id"),
    "last_seen_sync_run_id",
  ] as const);
  for (const item of items) {
    const row = flattenAttendance(item);
    if (row.attendance_id === null || row.employee_id === null) continue;
    const insert: Record<string, unknown> = {
      last_seen_sync_run_id: sync_run_id,
    };
    for (const c of ATTENDANCE_COLUMNS) {
      insert[c] = row[c];
    }
    await db
      .insert(attendance)
      .values(insert as typeof attendance.$inferInsert)
      .onConflictDoUpdate({
        target: attendance.attendance_id,
        set,
      });
  }
  return items.length;
}
