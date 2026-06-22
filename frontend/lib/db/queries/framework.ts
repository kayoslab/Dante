import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "../client";
import {
  customer,
  frameworkAgreement,
  frameworkRate,
  project,
} from "../schema";

export type FrameworkRate = {
  profile: string;
  valid_from: string;
  daily_rate_eur: string;
};

export type FrameworkDetail = {
  framework_id: number;
  customer_id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  created_at: string;
  rates: FrameworkRate[];
};

export async function getFrameworkDetail(
  framework_id: number,
): Promise<FrameworkDetail | null> {
  const [row] = await db
    .select({
      framework_id: frameworkAgreement.framework_id,
      customer_id: frameworkAgreement.customer_id,
      name: frameworkAgreement.name,
      start_date: frameworkAgreement.start_date,
      end_date: frameworkAgreement.end_date,
      notes: frameworkAgreement.notes,
      created_at: frameworkAgreement.created_at,
    })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (!row) return null;

  const rates = await db
    .select({
      profile: frameworkRate.profile,
      valid_from: frameworkRate.valid_from,
      daily_rate_eur: frameworkRate.daily_rate_eur,
    })
    .from(frameworkRate)
    .where(eq(frameworkRate.framework_id, framework_id))
    .orderBy(asc(frameworkRate.profile), asc(frameworkRate.valid_from));

  return {
    framework_id: row.framework_id,
    customer_id: row.customer_id,
    name: row.name,
    start_date: row.start_date,
    end_date: row.end_date,
    notes: row.notes,
    created_at: row.created_at.toISOString(),
    rates,
  };
}

// ----------------------------------------------------------------------------
// Mutations — used by `lib/actions/framework.ts`.
// ----------------------------------------------------------------------------

/** Existence probe for a `customer_id` — the action uses this so a
 * framework can't be parented under a deleted customer. */
export async function customerExistsForFramework(
  customer_id: number,
): Promise<boolean> {
  const rows = await db
    .select({ id: customer.customer_id })
    .from(customer)
    .where(eq(customer.customer_id, customer_id));
  return rows.length > 0;
}

/** Existence probe for a `framework_id`. */
export async function frameworkExists(framework_id: number): Promise<boolean> {
  const rows = await db
    .select({ id: frameworkAgreement.framework_id })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  return rows.length > 0;
}

/** Detect a name collision inside the same customer's framework list.
 * Returns the colliding `framework_id` or `null`. */
export async function findFrameworkByCustomerAndName(
  customer_id: number,
  name: string,
): Promise<number | null> {
  const rows = await db
    .select({ id: frameworkAgreement.framework_id })
    .from(frameworkAgreement)
    .where(
      and(
        eq(frameworkAgreement.customer_id, customer_id),
        eq(frameworkAgreement.name, name),
      ),
    );
  return rows[0]?.id ?? null;
}

/** Header fetch (name only) — used to compose the cascade-delete error. */
export async function getFrameworkName(
  framework_id: number,
): Promise<string | null> {
  const [row] = await db
    .select({ name: frameworkAgreement.name })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  return row?.name ?? null;
}

/** Insert a new framework, returning the newly minted id. */
export async function insertFramework(args: {
  customer_id: number;
  name: string;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
}): Promise<number> {
  const now = new Date();
  const [row] = await db
    .insert(frameworkAgreement)
    .values({
      customer_id: args.customer_id,
      name: args.name,
      start_date: args.start_date,
      end_date: args.end_date,
      notes: args.notes,
      created_at: now,
      updated_at: now,
    })
    .returning({ framework_id: frameworkAgreement.framework_id });
  return row.framework_id;
}

/** Partial update; stamps `updated_at` so callers don't have to. */
export async function updateFramework(
  framework_id: number,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .update(frameworkAgreement)
    .set({ ...updates, updated_at: new Date() })
    .where(eq(frameworkAgreement.framework_id, framework_id));
}

/** Counts the rate rows + projects linked to a framework — the cascade
 * guard uses these to decide whether `force=true` is required. */
export async function countFrameworkChildren(
  framework_id: number,
): Promise<{ n_rates: number; n_proj: number }> {
  const [row] = await db
    .select({
      n_rates: sql<number>`(SELECT COUNT(*)::int FROM ${frameworkRate} WHERE ${frameworkRate.framework_id} = ${framework_id})`,
      n_proj: sql<number>`(SELECT COUNT(*)::int FROM ${project} WHERE ${project.framework_id} = ${framework_id})`,
    })
    .from(sql`(SELECT 1) AS dummy`);
  return { n_rates: Number(row.n_rates), n_proj: Number(row.n_proj) };
}

/** Cascade-remove a framework: rates dropped, projects unlinked
 * (`framework_id` set to NULL), then the framework itself. Called only
 * when the action has decided to proceed (`force=true` or no children). */
export async function deleteFrameworkCascading(
  framework_id: number,
  force: boolean,
): Promise<void> {
  if (force) {
    await db
      .delete(frameworkRate)
      .where(eq(frameworkRate.framework_id, framework_id));
    await db
      .update(project)
      .set({ framework_id: null, updated_at: new Date() })
      .where(eq(project.framework_id, framework_id));
  }
  await db
    .delete(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
}

/** Resolve the "default" `valid_from` for a fresh rate — falls back to
 * the framework's `start_date` and then to today. */
export async function defaultFrameworkRateValidFrom(
  framework_id: number,
): Promise<string> {
  const [row] = await db
    .select({ start_date: frameworkAgreement.start_date })
    .from(frameworkAgreement)
    .where(eq(frameworkAgreement.framework_id, framework_id));
  if (row && row.start_date) return row.start_date;
  return new Date().toISOString().slice(0, 10);
}

/** Look up an existing rate at a precise (profile, valid_from) — caller
 * needs the existing daily rate to build a friendly conflict / not-found
 * message. Returns `null` when missing. */
export async function findFrameworkRate(
  framework_id: number,
  profile: string,
  valid_from: string,
): Promise<{ daily_rate_eur: string } | null> {
  const rows = await db
    .select({ daily_rate_eur: frameworkRate.daily_rate_eur })
    .from(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
  return rows[0] ?? null;
}

/** Insert a new (framework_id, profile, valid_from, rate) row. */
export async function insertFrameworkRate(args: {
  framework_id: number;
  profile: string;
  valid_from: string;
  daily_rate_eur: string;
}): Promise<void> {
  await db.insert(frameworkRate).values(args);
}

/** Update the rate for a specific (framework_id, profile, valid_from). */
export async function updateFrameworkRate(
  framework_id: number,
  profile: string,
  valid_from: string,
  daily_rate_eur: string,
): Promise<void> {
  await db
    .update(frameworkRate)
    .set({ daily_rate_eur })
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
}

/** Delete the rate for a specific (framework_id, profile, valid_from). */
export async function deleteFrameworkRate(
  framework_id: number,
  profile: string,
  valid_from: string,
): Promise<void> {
  await db
    .delete(frameworkRate)
    .where(
      and(
        eq(frameworkRate.framework_id, framework_id),
        eq(frameworkRate.profile, profile),
        eq(frameworkRate.valid_from, valid_from),
      ),
    );
}
