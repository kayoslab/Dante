import { asc, eq } from "drizzle-orm";

import { db } from "../client";
import { frameworkAgreement, frameworkRate } from "../schema";

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
