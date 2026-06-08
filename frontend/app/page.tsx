import Link from "next/link";

import { PortfolioMonthlyCard } from "@/components/portfolio/portfolio-monthly-card";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { hasRole, requireSession } from "@/lib/auth/session";

export default async function Home() {
  const ctx = await requireSession();

  // Employees land here too but the portfolio card shows project margins +
  // revenue — financial data they can't see. Give them a focused welcome
  // pointing at /profile and /calendar.
  if (!hasRole(ctx, "manager")) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Welcome to Dante
          </h1>
          <p className="text-sm text-muted-foreground">
            Your home for assignments, time tracking, and team visibility.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="space-y-2 py-6">
              <h2 className="text-base font-semibold">Your profile</h2>
              <p className="text-sm text-muted-foreground">
                Your core details, current assignments, and tracked time.
              </p>
              <Link
                href="/profile"
                className={buttonVariants({ size: "sm" }) + " mt-2"}
              >
                Open profile
              </Link>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 py-6">
              <h2 className="text-base font-semibold">Team calendar</h2>
              <p className="text-sm text-muted-foreground">
                See who&rsquo;s on what across the team.
              </p>
              <Link
                href="/calendar"
                className={
                  buttonVariants({ size: "sm", variant: "outline" }) + " mt-2"
                }
              >
                Open calendar
              </Link>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Home</h1>
      </div>

      <PortfolioMonthlyCard />
    </div>
  );
}
