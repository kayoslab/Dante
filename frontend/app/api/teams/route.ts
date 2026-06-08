import { asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { employeeAnnotation, team } from "@/lib/db/schema";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const rows = await db
      .select({
        team_name: team.team_name,
        n_members: sql<number>`COUNT(${employeeAnnotation.employee_id})::int`.as(
          "n_members",
        ),
      })
      .from(team)
      .leftJoin(
        employeeAnnotation,
        eq(employeeAnnotation.team_user, team.team_name),
      )
      .groupBy(team.team_name)
      .orderBy(asc(team.team_name));
    return rows;
  });
}
