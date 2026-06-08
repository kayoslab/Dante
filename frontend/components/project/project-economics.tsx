import type { ProjectEconomics } from "@/lib/api/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatEUR, formatPercent } from "@/lib/format";

export function ProjectEconomicsCard({ economics }: { economics: ProjectEconomics }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monthly run rate</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div className="text-muted-foreground">Revenue</div>
        <div className="text-right tabular-nums">
          {formatEUR(economics.monthly_revenue_now)}
        </div>
        <div className="text-muted-foreground">Internal cost</div>
        <div className="text-right tabular-nums">
          {formatEUR(economics.monthly_internal_cost_now)}
        </div>
        <div className="text-muted-foreground">External cost</div>
        <div className="text-right tabular-nums">
          {formatEUR(economics.monthly_external_cost_now)}
        </div>
        <div className="border-t pt-2 font-medium">Gross margin</div>
        <div className="border-t pt-2 text-right font-medium tabular-nums">
          {formatEUR(economics.monthly_gross_margin_now)}{" "}
          <span className="text-muted-foreground">
            ({formatPercent(economics.monthly_gross_margin_pct)})
          </span>
        </div>
        <div className="text-muted-foreground">Staff</div>
        <div className="text-right tabular-nums">
          {economics.n_current_employees} employees / {economics.n_current_freelancers} freelancers
        </div>
      </CardContent>
    </Card>
  );
}
