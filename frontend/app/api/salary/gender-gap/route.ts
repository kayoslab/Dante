import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { enforceRateLimit } from "@/lib/api/rate-limit";

const VALID_GROUPING = new Set(["tier", "team"]);
const VALID_BASIS = new Set(["fix", "total"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    enforceRateLimit(ctx, "salary_gender_gap", "expensive");
    const { searchParams } = new URL(req.url);
    const grouping = searchParams.get("grouping") ?? "tier";
    const basis = searchParams.get("basis") ?? "fix";
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation("grouping must be tier|team");
    }
    if (!VALID_BASIS.has(basis)) {
      throw Validation("basis must be fix|total");
    }
    await audit(ctx, {
      action: "view_gender_gap",
      target_type: "salary_insights",
      target_id: `${grouping}/${basis}`,
    });

    const view = sql.raw(
      basis === "total"
        ? grouping === "tier"
          ? "gender_pay_gap_total_by_tier"
          : "gender_pay_gap_total_by_team"
        : grouping === "tier"
          ? "gender_pay_gap_by_tier"
          : "gender_pay_gap_by_team",
    );
    const groupCol = sql.raw(grouping === "tier" ? "tier" : "team");
    const orderClause =
      grouping === "tier"
        ? sql`CASE tier
            WHEN 'junior' THEN 1 WHEN 'advanced' THEN 2
            WHEN 'senior' THEN 3 WHEN 'expert' THEN 4 ELSE 5 END`
        : sql`team`;

    const r = await db.execute(sql`
      SELECT ${groupCol} AS group_key, n_female, median_female,
             n_male, median_male, gap_pct_female_below_male
      FROM ${view}
      ORDER BY ${orderClause}
    `);

    return (r.rows as Array<Record<string, unknown>>).map((row) => ({
      group_key: row.group_key,
      n_female: row.n_female === null ? null : Number(row.n_female),
      median_female:
        row.median_female === null ? null : Number(row.median_female),
      n_male: row.n_male === null ? null : Number(row.n_male),
      median_male: row.median_male === null ? null : Number(row.median_male),
      gap_pct_female_below_male:
        row.gap_pct_female_below_male === null
          ? null
          : Number(row.gap_pct_female_below_male),
    }));
  });
}
