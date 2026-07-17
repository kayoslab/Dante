/** Personio v2 /projects → personio_project rows.
 *
 * The dropdown consultants pick when logging attendance time;
 * attendance.project_id refers to these. Stored here for the project-link
 * mapping UI.
 *
 * v2 shape differs from v1: flat `{ id, name, status }` (no `attributes`
 * envelope), `id` is a string, and `active` is derived from the
 * `status` enum (`ACTIVE` / `ARCHIVED`). */
import { and, sql } from "drizzle-orm";
import type { Client } from "pg";

import { personioProject } from "@/lib/db/schema";
import { log } from "@/lib/logger";
import { syncDrizzle } from "@/lib/sync/db";
import { excludedSet } from "@/lib/sync/_upsert";

import type { PersonioClient } from "./client";

type V2Project = {
  id?: string;
  name?: string | null;
  status?: string | null;
  billable?: boolean | null;
  // v2 subproject relationship — a nested object whose `id` is the parent
  // project's id, or absent/null for a top-level project.
  parent_project?: { id?: string | null } | null;
};

export async function syncPersonioProjects(
  conn: Client,
  client: PersonioClient,
  sync_run_id: number,
): Promise<number> {
  const db = syncDrizzle(conn);
  const items = await client.listPersonioProjects();
  const now = new Date();

  // TEMP DIAGNOSTIC (remove after): confirm the raw v2 /projects shape from
  // the live tenant — whether ARCHIVED projects are returned at all, where
  // `status` lives, and whether `parent_project.id` is present. Read from
  // CloudWatch: filter the sync log group for event="personio_projects_diag".
  {
    const statusCounts: Record<string, number> = {};
    let withParent = 0;
    for (const it of items) {
      const p = it as V2Project;
      const s = String(p.status ?? "(missing)");
      statusCounts[s] = (statusCounts[s] ?? 0) + 1;
      if (p.parent_project?.id) withParent += 1;
    }
    const sample =
      items.find((it) => /jost|companion/i.test((it as V2Project).name ?? "")) ??
      items[0];
    log.info("personio_projects_diag", {
      total: items.length,
      status_counts: statusCounts,
      with_parent: withParent,
      sample_raw: JSON.stringify(sample ?? null),
    });
  }
  const set = excludedSet([
    "name",
    "active",
    "billable",
    "parent_id",
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
        // v2 subproject parent id, or null for a top-level project.
        parent_id: p.parent_project?.id ?? null,
        last_seen_sync_run_id: sync_run_id,
        last_updated_at: now,
      })
      .onConflictDoUpdate({
        target: personioProject.personio_project_id,
        set,
      });
    count += 1;
  }

  // Stale detection. This endpoint returns the FULL project list every run
  // (no incremental filter), so any stored row NOT stamped with this run's id
  // has vanished from Personio — deleted, or hidden from the API. Mark those
  // archived (active = false) rather than deleting the row, so historical
  // attendance keeps its project name and the link picker just hides them by
  // default. Guarded on a non-empty pull: a transient empty response must
  // never archive the whole table.
  if (items.length > 0) {
    await db
      .update(personioProject)
      .set({ active: false, last_updated_at: now })
      .where(
        and(
          sql`${personioProject.last_seen_sync_run_id} IS DISTINCT FROM ${sync_run_id}`,
          sql`${personioProject.active} IS DISTINCT FROM false`,
        ),
      );
  }

  return count;
}
