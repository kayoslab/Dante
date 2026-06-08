/** Personio /company/attendances/projects → personio_project rows.
 *
 * The dropdown consultants pick when logging attendance time;
 * attendance.project_id refers to these. Stored here for the project-link
 * mapping UI. */
import type { Client } from "pg";

import { personioProject } from "@/lib/db/schema";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { PersonioClient } from "./client";

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
    "last_seen_sync_run_id",
    "last_updated_at",
  ] as const);
  for (const item of items) {
    const attrs =
      (item as { attributes?: Record<string, unknown> }).attributes ?? {};
    const pid = (item as { id?: unknown }).id;
    if (pid === null || pid === undefined) continue;
    await db
      .insert(personioProject)
      .values({
        personio_project_id: Number(pid),
        name: ((attrs.name as string | undefined) ?? "") as string,
        active: (attrs.active as boolean | undefined) ?? null,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: personioProject.personio_project_id,
        set,
      });
  }
  return items.length;
}
