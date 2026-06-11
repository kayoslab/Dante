import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { SdmProjectTile } from "@/lib/db/queries/sdm-home";

/** "Projects I manage" — rendered on Home for employee-role users with
 * at least one `project_sdm` grant. Each tile shows the customer + project
 * name, how many freelancer assignments are on it, and a missing-hours
 * badge nag for months without an entered/auto-filled `freelancer_time_entry`
 * row. Click → /projects/[id].
 *
 * Returns null when there are no tiles so callers can render this
 * unconditionally without an empty section. */
export function SdmProjectsSection({ tiles }: { tiles: SdmProjectTile[] }) {
  if (tiles.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Projects I manage
        </h2>
        <p className="text-xs text-muted-foreground">
          Projects you have Service Delivery Manager access to. Missing
          hours = freelancer-assignment months without a logged entry.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((t) => (
          <Link
            key={t.project_id}
            href={`/projects/${t.project_id}`}
            className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground rounded-md"
          >
            <Card className="h-full transition hover:bg-muted/30">
              <CardContent className="space-y-2 py-4">
                <div className="text-xs text-muted-foreground">
                  {t.customer_name}
                </div>
                <div className="text-sm font-semibold">{t.name}</div>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline">{t.status}</Badge>
                  <span className="text-muted-foreground">
                    {t.n_freelancer_assignments} freelancer
                    {t.n_freelancer_assignments === 1 ? "" : "s"}
                  </span>
                  {t.n_missing_months > 0 && (
                    <Badge variant="destructive">
                      {t.n_missing_months} month
                      {t.n_missing_months === 1 ? "" : "s"} missing hours
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
