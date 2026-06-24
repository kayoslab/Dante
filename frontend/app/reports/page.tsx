import Link from "next/link";
import { forbidden } from "next/navigation";

import { Card, CardContent } from "@/components/ui/card";
import type { Role } from "@/lib/auth";
import { audit } from "@/lib/auth/audit";
import { hasRole, requireSession } from "@/lib/auth/session";

export const metadata = { title: "Reports — Dante" };

// Each tile is rendered only when the viewer meets its per-report
// role gate. The page itself gates at manager+, so employees never
// reach this point; admins inherit everything.
type ReportTile = {
  href: string;
  title: string;
  description: string;
  minRole: Role;
};

const REPORTS: ReportTile[] = [
  {
    href: "/reports/portfolio-rentability",
    title: "Portfolio rentability",
    description:
      "Revenue, cost, margin across every project. Trailing 12-month trend + 3-month forecast; per-month KPI, bench, and project breakdown.",
    minRole: "manager",
  },
  {
    href: "/reports/customer-rentability",
    title: "Customer rentability",
    description:
      "Who carries us, and how concentrated is the risk. Top-5 customer margin trend, Pareto table, concentration metrics (HHI included), and ending-project radar.",
    minRole: "manager",
  },
  {
    href: "/reports/fp-burndown",
    title: "Fixed-price burn-down",
    description:
      "One row per active FP project — time-budget burn vs plan, with status badges and EUR strip. Sorted by risk. Navigate months to see historical snapshots.",
    minRole: "manager",
  },
  {
    href: "/reports/utilization",
    title: "Utilization",
    description:
      "Are we using the people we pay for? Trend + per-team and per-role-tier rollups, currently-benched and overbooked consultants, and what's driving the forecast.",
    minRole: "manager",
  },
  {
    href: "/reports/salary",
    title: "Salary insights",
    description:
      "Distribution by role tier, gender-gap analysis, outliers, and per-employee salary history.",
    minRole: "manager",
  },
];

export default async function ReportsPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "manager")) forbidden();

  await audit(ctx, {
    action: "view_reports_list",
    target_type: "reports_list",
    target_id: null,
  });

  const visible = REPORTS.filter((r) => hasRole(ctx, r.minRole));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Org-wide analytics surfaces. You see the reports your role grants
          access to.
        </p>
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No reports available for your role.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((r) => (
            <Link
              key={r.href}
              href={r.href}
              className="block rounded-md border bg-background p-4 transition hover:bg-muted/30"
            >
              <h2 className="text-base font-semibold">{r.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {r.description}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
