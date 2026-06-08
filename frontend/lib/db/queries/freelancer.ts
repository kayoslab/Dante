import { eq } from "drizzle-orm";

import { db } from "../client";
import { freelancer } from "../schema";

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
