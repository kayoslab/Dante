import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

type BandRow = {
  group_key: string | null;
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
};

const VALID_GROUPING = new Set(["tier", "team", "department"]);

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const grouping = searchParams.get("grouping") ?? "tier";
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation(`grouping must be tier|team|department`);
    }
    await audit(ctx, {
      action: "view_salary_bands",
      target_type: "salary_insights",
      target_id: grouping,
    });

    if (grouping === "tier") {
      const r = await db.execute(sql`
        SELECT role_tier AS group_key, n, min, p25, median, p75, max
        FROM role_tier_band
        ORDER BY CASE role_tier
          WHEN 'junior' THEN 1 WHEN 'advanced' THEN 2
          WHEN 'senior' THEN 3 WHEN 'expert' THEN 4 ELSE 5 END
      `);
      return (r.rows as Array<Record<string, unknown>>).map((row) => ({
        group_key: row.group_key,
        n: Number(row.n),
        min: Number(row.min),
        p25: Number(row.p25),
        median: Number(row.median),
        p75: Number(row.p75),
        max: Number(row.max),
      }));
    }

    const groupCol =
      grouping === "team" ? sql.raw("a.team_user") : sql.raw("ec.department");

    const r = await db.execute(sql`
      WITH base AS (
        SELECT
          ${groupCol} AS group_key,
          esn.monthly_salary_fte
        FROM employee_current ec
        JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
        LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
        WHERE ec.status = 'active'
          AND esn.monthly_salary_fte IS NOT NULL
          AND ${groupCol} IS NOT NULL
          AND COALESCE(a.is_multi_org, FALSE) = FALSE
          AND COALESCE(a.is_real_employee, TRUE) = TRUE
      )
      SELECT
        group_key,
        COUNT(*) AS n,
        CAST(MIN(monthly_salary_fte) AS INTEGER) AS min,
        CAST(PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p25,
        CAST(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS median,
        CAST(PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY monthly_salary_fte) AS INTEGER) AS p75,
        CAST(MAX(monthly_salary_fte) AS INTEGER) AS max
      FROM base
      GROUP BY group_key
      HAVING COUNT(*) >= 1
      ORDER BY group_key
    `);
    return (r.rows as Array<Record<string, unknown>>).map<BandRow>((row) => ({
      group_key: row.group_key === null ? null : String(row.group_key),
      n: Number(row.n),
      min: Number(row.min),
      p25: Number(row.p25),
      median: Number(row.median),
      p75: Number(row.p75),
      max: Number(row.max),
    }));
  });
}
