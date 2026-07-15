/** Personio v2 /projects → personio_project rows.
 *
 * The dropdown consultants pick when logging attendance time;
 * attendance.project_id refers to these. Stored here for the project-link
 * mapping UI.
 *
 * v2 shape differs from v1: flat `{ id, name, status }` (no `attributes`
 * envelope), `id` is a string, and `active` is derived from the
 * `status` enum (`ACTIVE` / `ARCHIVED`). */
import type { Client } from "pg";

import { personioProject } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { PersonioClient } from "./client";

type V2Project = {
  id?: string;
  name?: string | null;
  status?: string | null;
  billable?: boolean | null;
};

export async function syncPersonioProjects(
  conn: Client,
  client: PersonioClient,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listPersonioProjects();
  const now = new Date();
  const set = excludedSet([
    "name",
    "active",
    "billable",
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  let count = 0;
  for (const item of items) {
    const p = item as V2Project;
    const pid = p.id;
    if (!pid) continue;
    await db
      .insert(personioProject)
      .values({
        personio_project_id: pid,
        name: p.name ?? "",
        // ACTIVE / ARCHIVED enum → boolean `active`. Null status leaves
        // `active` null rather than guessing.
        active: p.status ? p.status === "ACTIVE" : null,
        // v2 per-project billable flag. Source of truth for unlinked
        // projects; seeds the Dante project on link for linked ones.
        billable: p.billable ?? null,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: personioProject.personio_project_id,
        set,
      });
    count += 1;
  }
  return count;
}
