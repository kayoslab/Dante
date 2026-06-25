import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SecurityCard } from "@/components/profile/security-card";
import { listMyAssignments } from "@/lib/db/queries/assignment";
import { getEmployeeDetail } from "@/lib/db/queries/employee";
import { hasRole, requireSession } from "@/lib/auth/session";
import { hasCognitoSession } from "@/lib/auth/cognito-tokens";
import { getTotpEnabled } from "@/lib/auth/cognito-self-service";

export const metadata = { title: "Profile — Dante" };

/** Personal profile page. Everyone authenticated can reach this; what we
 * show is their OWN data, never anyone else's.
 *
 * Employees see core profile + their own assignments (no rates / cost).
 * Managers + admins land here too if they click "Profile" in the top nav,
 * but they have other paths to the same data via /employees/[id]. */
export default async function ProfilePage() {
  const ctx = await requireSession();

  if (ctx.employee_id === null) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        </div>
        <Card>
          <CardContent className="py-6">
            <p className="text-sm">
              Your user account isn&rsquo;t linked to a Personio employee
              record yet. Ask an administrator to link it from{" "}
              <code>/settings/users</code>.
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Signed in as <code>{ctx.email}</code>.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const data = await getEmployeeDetail(ctx.employee_id);
  if (!data) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <Card>
          <CardContent className="py-6 text-sm">
            Couldn&rsquo;t find your linked employee record (#{ctx.employee_id}).
            Ask an administrator.
          </CardContent>
        </Card>
      </div>
    );
  }

  // Assignments (no rates, no costs). Manager+ click through to projects;
  // employees see project names as plain text.
  const assignmentRows = await listMyAssignments(ctx.employee_id);

  const canLinkProjects = hasRole(ctx, "manager");

  let securityProps: { initialTotpEnabled: boolean } | null = null;
  if (await hasCognitoSession()) {
    securityProps = { initialTotpEnabled: await getTotpEnabled() };
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {data.first_name} {data.last_name}
        </h1>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="secondary">{data.status ?? "unknown"}</Badge>
          {data.role_tier && (
            <Badge variant="outline">{data.role_tier}</Badge>
          )}
          {data.team && <Badge variant="outline">{data.team}</Badge>}
          {data.position && <span>{data.position}</span>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Personal</CardTitle>
        </CardHeader>
        <CardContent>
          <KeyValueGrid
            items={[
              ["Email", data.email ?? "—"],
              ["Hire date", data.hire_date ?? "—"],
              [
                "Leaving date",
                data.employment_end_date ?? data.contract_end_date ?? "—",
              ],
              ["Employment type", data.employment_type ?? "—"],
              [
                "FTE",
                data.fte !== null ? data.fte.toFixed(2) : "—",
              ],
              ["Weekly hours", data.weekly_working_hours ?? "—"],
              ["Office", data.office ?? "—"],
              ["Subcompany", data.subcompany ?? "—"],
              ["Cost center", data.cost_center ?? "—"],
            ]}
          />
        </CardContent>
      </Card>

      {securityProps && (
        <SecurityCard initialTotpEnabled={securityProps.initialTotpEnabled} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Agent integration</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <p className="text-muted-foreground">
            Configure Vercel EVE (or any OAuth-aware agent framework) to call{" "}
            <code>/api/agent/*</code> on your behalf. Sign-in goes through
            Cognito with MFA — the agent inherits your account security.
          </p>
          <p className="mt-2">
            <Link href="/profile/agents" className="underline hover:text-foreground">
              View OAuth endpoints + scopes →
            </Link>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Assignments ({assignmentRows.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {assignmentRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No assignments on record.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Project</th>
                    <th className="px-3 py-2 text-left font-medium">Profile</th>
                    <th className="px-3 py-2 text-right font-medium">Alloc</th>
                    <th className="px-3 py-2 text-left font-medium">Period</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {assignmentRows.map((a) => (
                    <tr key={a.assignment_id}>
                      <td className="px-3 py-2 align-top">
                        <span className="text-muted-foreground">
                          {a.customer_name}
                        </span>
                        <span className="text-muted-foreground"> / </span>
                        {canLinkProjects ? (
                          <Link
                            href={`/projects/${a.project_id}`}
                            className="font-medium hover:underline"
                          >
                            {a.project_name}
                          </Link>
                        ) : (
                          <span className="font-medium">{a.project_name}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-muted-foreground">
                        {a.profile ?? "—"}
                      </td>
                      <td className="px-3 py-2 align-top text-right tabular-nums">
                        {Number(a.allocation_pct).toFixed(2)}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap text-muted-foreground tabular-nums">
                        <div>{a.start_date}</div>
                        <div className="text-xs">
                          → {a.end_date ?? "open"}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function KeyValueGrid({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
