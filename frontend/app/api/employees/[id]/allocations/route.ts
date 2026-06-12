import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { roleTierFromAlias } from "@/lib/db/_sql-fragments";
import { audit } from "@/lib/auth/audit";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }

    // role_tier needs ec + ann aliases. The rate-resolution subqueries are
    // inlined rather than fragment-composed — they reference outer aliases
    // (`a`, `p`) which is awkward to express via a generic helper.
    const roleTier = roleTierFromAlias("ec", "ann");
    const result = await db.execute(sql`
      SELECT
        a.assignment_id, a.project_id, p.name AS project_name,
        c.name AS customer_name, p.billing_model,
        COALESCE(a.profile, ${roleTier}) AS profile,
        a.allocation_pct, a.start_date, a.end_date,
        COALESCE(
          a.daily_rate_override_eur,
          (SELECT daily_rate_eur FROM project_rate pr
           WHERE pr.project_id = a.project_id
             AND pr.profile = COALESCE(a.profile, ${roleTier})
             AND pr.valid_from <= a.start_date
           ORDER BY pr.valid_from DESC LIMIT 1),
          (SELECT daily_rate_eur FROM framework_rate fr
           WHERE fr.framework_id = p.framework_id
             AND fr.profile = COALESCE(a.profile, ${roleTier})
             AND fr.valid_from <= a.start_date
           ORDER BY fr.valid_from DESC LIMIT 1)
        ) AS effective_daily_rate_eur,
        (a.start_date <= CURRENT_DATE
         AND (a.end_date IS NULL OR a.end_date >= CURRENT_DATE)) AS is_active_today
      FROM assignment a
      JOIN project p ON p.project_id = a.project_id
      JOIN customer c ON c.customer_id = p.customer_id
      LEFT JOIN employee_current ec ON ec.employee_id = a.employee_id
      LEFT JOIN employee_annotation ann ON ann.employee_id = a.employee_id
      WHERE a.employee_id = ${employee_id}
      ORDER BY a.start_date DESC, a.assignment_id DESC
    `);

    await audit(ctx, {
      action: "view_employee_allocations",
      target_type: "employee",
      target_id: employee_id,
    });

    return (result.rows as Array<Record<string, unknown>>).map((r) => ({
      assignment_id: r.assignment_id,
      project_id: r.project_id,
      project_name: r.project_name,
      customer_name: r.customer_name,
      billing_model: r.billing_model,
      profile: r.profile,
      allocation_pct: Number(r.allocation_pct).toFixed(4),
      start_date: r.start_date,
      end_date: r.end_date,
      is_active_today: Boolean(r.is_active_today),
      effective_daily_rate_eur:
        r.effective_daily_rate_eur === null || r.effective_daily_rate_eur === undefined
          ? null
          : Number(r.effective_daily_rate_eur).toFixed(2),
    }));
  });
}
