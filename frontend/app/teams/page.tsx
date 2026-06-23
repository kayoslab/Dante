import Link from "next/link";
import { forbidden } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import { audit } from "@/lib/auth/audit";
import { listTeams } from "@/lib/db/queries/team";
import { teamSlug } from "@/lib/team-slug";
import { hasRole, requireSession } from "@/lib/auth/session";

export const metadata = { title: "Teams — Dante" };

// Headcount + financials depend on live assignment data; never cache.
export const dynamic = "force-dynamic";

/** Manager/admin-only team index. Not in nav — reached from the home
 * "Per team" bench rollup and from the `/employees` Team column.
 * Detail pages live at `/teams/[slug]`. */
export default async function TeamsIndexPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_team_list",
    target_type: "team_list",
    target_id: null,
  });

  const teams = await listTeams();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Teams</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          One entry per team that has at least one employee assigned, plus
          empty teams created via /settings. Click a row for the per-team
          P&L, roster, and 3-month forecast.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Team</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Headcount
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {teams.length === 0 && (
                  <tr>
                    <td
                      colSpan={2}
                      className="px-3 py-6 text-center text-sm text-muted-foreground"
                    >
                      No teams on file yet. Create one via{" "}
                      <Link
                        href="/settings/users"
                        className="hover:underline"
                      >
                        /settings/users
                      </Link>
                      .
                    </td>
                  </tr>
                )}
                {teams.map((t) => (
                  <tr key={t.team_name} className="hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <Link
                        href={`/teams/${teamSlug(t.team_name)}`}
                        className="font-medium hover:underline"
                      >
                        {t.team_name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {t.n_members}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
