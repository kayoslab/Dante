import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }

    const result = await db.execute(sql`
      SELECT effective_date, new_annual_eur, old_annual_eur, source
      FROM salary_change_event
      WHERE employee_id = ${employee_id}
        AND new_annual_eur > 1000
      ORDER BY effective_date ASC, event_id ASC
    `);

    return (result.rows as Array<Record<string, unknown>>).map((r) => {
      const newV = r.new_annual_eur === null || r.new_annual_eur === undefined
        ? null
        : Number(r.new_annual_eur);
      const oldV = r.old_annual_eur === null || r.old_annual_eur === undefined
        ? null
        : Number(r.old_annual_eur);
      let delta_eur: number | null = null;
      let delta_pct: number | null = null;
      if (newV !== null && oldV !== null && oldV > 0) {
        delta_eur = newV - oldV;
        delta_pct = (delta_eur / oldV) * 100;
      }
      return {
        effective_date: r.effective_date,
        annual_eur: newV === null ? null : newV.toFixed(2),
        previous_annual_eur: oldV === null ? null : oldV.toFixed(2),
        delta_eur: delta_eur === null ? null : delta_eur.toFixed(2),
        delta_pct: delta_pct === null ? null : delta_pct.toFixed(2),
        source: r.source,
      };
    });
  });
}
