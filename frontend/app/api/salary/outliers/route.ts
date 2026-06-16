import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

type Grouping = "tier" | "team" | "department";
const VALID_GROUPING = new Set<Grouping>(["tier", "team", "department"]);

const TIER_ORDER = ["junior", "advanced", "senior", "expert"] as const;
type Tier = (typeof TIER_ORDER)[number];

type EmployeeRow = {
  employee_id: number;
  name: string;
  position: string | null;
  group_key: string;
  salary: number;
};

type Reason = {
  kind: "in_band" | "cross_band";
  label: string;
  reference: number;
  delta: number;
};

type SalaryOutlier = {
  employee_id: number;
  name: string;
  position: string | null;
  group_key: string;
  salary: number;
  reasons: Reason[];
};

export async function GET(req: NextRequest) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { searchParams } = new URL(req.url);
    const grouping = (searchParams.get("grouping") ?? "tier") as Grouping;
    if (!VALID_GROUPING.has(grouping)) {
      throw Validation("grouping must be tier|team|department");
    }
    await audit(ctx, {
      action: "view_salary_outliers",
      target_type: "salary_insights",
      target_id: grouping,
    });

    const groupCol =
      grouping === "tier"
        ? sql.raw("rt.role_tier")
        : grouping === "team"
          ? sql.raw("a.team_user")
          : sql.raw("ec.department");

    const joinRoleTier =
      grouping === "tier"
        ? sql`JOIN employee_role_tier rt ON rt.employee_id = ec.employee_id`
        : sql``;

    const r = await db.execute(sql`
      SELECT
        ec.employee_id,
        ec.first_name,
        ec.last_name,
        ec.position,
        ${groupCol} AS group_key,
        esn.monthly_salary_fte AS salary
      FROM employee_current ec
      JOIN employee_salary_normalized esn ON esn.employee_id = ec.employee_id
      LEFT JOIN employee_annotation a ON a.employee_id = ec.employee_id
      ${joinRoleTier}
      WHERE ec.status = 'active'
        AND esn.monthly_salary_fte IS NOT NULL
        AND ${groupCol} IS NOT NULL
        AND COALESCE(a.is_multi_org, FALSE) = FALSE
        AND COALESCE(a.is_real_employee, TRUE) = TRUE
    `);

    const rows: EmployeeRow[] = (
      r.rows as Array<Record<string, unknown>>
    ).map((row) => ({
      employee_id: Number(row.employee_id),
      name: [row.first_name, row.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || `#${row.employee_id}`,
      position: row.position === null ? null : String(row.position),
      group_key: String(row.group_key),
      salary: Number(row.salary),
    }));

    return identifyOutliers(rows, grouping);
  });
}

function identifyOutliers(
  rows: EmployeeRow[],
  grouping: Grouping,
): SalaryOutlier[] {
  const byGroup = new Map<string, number[]>();
  for (const r of rows) {
    const arr = byGroup.get(r.group_key) ?? [];
    arr.push(r.salary);
    byGroup.set(r.group_key, arr);
  }

  const stats = new Map<
    string,
    { max: number; upper_fence: number | null }
  >();
  for (const [key, salaries] of byGroup.entries()) {
    salaries.sort((a, b) => a - b);
    const p25 = quantile(salaries, 0.25);
    const p75 = quantile(salaries, 0.75);
    const iqr = p75 - p25;
    const max = salaries[salaries.length - 1] ?? 0;
    // Tukey's high fence; only meaningful when we have enough points to
    // get a stable IQR. Below that, the fence collapses and every entry
    // looks like an outlier.
    const upper_fence = salaries.length >= 4 ? p75 + 1.5 * iqr : null;
    stats.set(key, { max, upper_fence });
  }

  const out: SalaryOutlier[] = [];
  for (const r of rows) {
    const reasons: Reason[] = [];

    if (grouping === "tier") {
      const myRank = TIER_ORDER.indexOf(r.group_key as Tier);
      if (myRank !== -1) {
        // Pick the HIGHEST-ranked tier the salary exceeds, not the largest
        // delta. Telling the user "exceeds expert max by €X" is more
        // informative than "exceeds senior max by €(X+gap)" — expert is
        // the ceiling, so blowing past it is the striking fact.
        let highest: { tier: Tier; max: number; delta: number } | null = null;
        for (let i = myRank + 1; i < TIER_ORDER.length; i++) {
          const higher = TIER_ORDER[i] as Tier;
          const higherStats = stats.get(higher);
          if (!higherStats || higherStats.max <= 0) continue;
          if (r.salary > higherStats.max) {
            highest = {
              tier: higher,
              max: higherStats.max,
              delta: r.salary - higherStats.max,
            };
          }
        }
        if (highest) {
          reasons.push({
            kind: "cross_band",
            label: `above ${highest.tier} band max`,
            reference: highest.max,
            delta: highest.delta,
          });
        }
      }
    }

    const own = stats.get(r.group_key);
    if (own?.upper_fence !== null && own?.upper_fence !== undefined) {
      if (r.salary > own.upper_fence) {
        reasons.push({
          kind: "in_band",
          label: `above ${r.group_key} upper fence (p75 + 1.5·IQR)`,
          reference: Math.round(own.upper_fence),
          delta: Math.round(r.salary - own.upper_fence),
        });
      }
    }

    if (reasons.length > 0) {
      out.push({
        employee_id: r.employee_id,
        name: r.name,
        position: r.position,
        group_key: r.group_key,
        salary: r.salary,
        reasons,
      });
    }
  }

  out.sort((a, b) => {
    const maxDelta = (o: SalaryOutlier) =>
      Math.max(...o.reasons.map((rs) => rs.delta));
    return maxDelta(b) - maxDelta(a);
  });
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}
