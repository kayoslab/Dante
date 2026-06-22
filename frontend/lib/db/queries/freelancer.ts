import { eq } from "drizzle-orm";

import { db } from "../client";
import { assignment, freelancer } from "../schema";

export type FreelancerDetail = {
  freelancer_id: number;
  name: string;
  daily_cost_eur: string;
  status: string;
  contact_email: string | null;
  notes: string | null;
  created_at: string;
};

export async function getFreelancerDetail(
  freelancer_id: number,
): Promise<FreelancerDetail | null> {
  const [row] = await db
    .select({
      freelancer_id: freelancer.freelancer_id,
      name: freelancer.name,
      daily_cost_eur: freelancer.daily_cost_eur,
      status: freelancer.status,
      contact_email: freelancer.contact_email,
      notes: freelancer.notes,
      created_at: freelancer.created_at,
    })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  if (!row) return null;
  return {
    ...row,
    created_at: row.created_at.toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Mutation helpers backing `lib/actions/freelancer.ts`.
// ----------------------------------------------------------------------------

/** Returns the freelancer_id when a row with the same name already
 * exists, or null otherwise. Used for the pre-insert dup check. */
export async function findFreelancerIdByName(
  name: string,
): Promise<number | null> {
  const r = await db
    .select({ id: freelancer.freelancer_id })
    .from(freelancer)
    .where(eq(freelancer.name, name));
  return r[0]?.id ?? null;
}

export async function freelancerExists(freelancer_id: number): Promise<boolean> {
  const r = await db
    .select({ id: freelancer.freelancer_id })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  return r.length > 0;
}

export type FreelancerInsert = {
  name: string;
  daily_cost_eur: string;
  status: string;
  contact_email: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

/** Insert a freelancer row and return the new id. The caller catches
 * `isUniqueViolation` for the rare race where two managers create the
 * same name concurrently. */
export async function insertFreelancer(
  values: FreelancerInsert,
): Promise<number> {
  const inserted = await db
    .insert(freelancer)
    .values(values)
    .returning({ freelancer_id: freelancer.freelancer_id });
  return inserted[0].freelancer_id;
}

export async function updateFreelancerById(
  freelancer_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(freelancer)
    .set(updates)
    .where(eq(freelancer.freelancer_id, freelancer_id));
}

export async function getFreelancerName(
  freelancer_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ name: freelancer.name })
    .from(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
  return row?.name ?? null;
}

export async function countFreelancerAssignments(
  freelancer_id: number,
): Promise<number> {
  const r = await db
    .select({ id: assignment.assignment_id })
    .from(assignment)
    .where(eq(assignment.freelancer_id, freelancer_id));
  return r.length;
}

/** Delete the freelancer row and (optionally) its assignments. Mirrors
 * the prior inline two-step in `deleteFreelancerAction`: no surrounding
 * transaction — kept that way deliberately so changing behaviour is a
 * separate decision. */
export async function deleteFreelancerCascading(
  freelancer_id: number,
  opts: { cascadeAssignments: boolean },
): Promise<void> {
  if (opts.cascadeAssignments) {
    await db
      .delete(assignment)
      .where(eq(assignment.freelancer_id, freelancer_id));
  }
  await db
    .delete(freelancer)
    .where(eq(freelancer.freelancer_id, freelancer_id));
}
