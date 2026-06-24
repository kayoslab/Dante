"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { PortfolioProjectRow } from "@/lib/api/portfolio";
import { formatEUR, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Per-project P&L table — shared by the Home project list and the
 * rentability report. Renders the customer/project label, billing
 * model badge, assignment count, and monthly P&L (revenue / cost /
 * margin / margin %). Per-row badges flag FP over-budget and missing
 * freelancer hours.
 *
 * The KPI grid and bench breakdown that previously lived in this file
 * were retired when the rentability report moved to an income-statement
 * layout; the surviving export is the table only. */
export function ProjectTable({ rows }: { rows: PortfolioProjectRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No projects had active assignments in this month.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Customer / Project</th>
            <th className="px-3 py-2 text-left font-medium">Model</th>
            <th className="px-3 py-2 text-right font-medium">Asgn</th>
            <th className="px-3 py-2 text-right font-medium">Revenue</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
            <th className="px-3 py-2 text-right font-medium">Margin</th>
            <th className="px-3 py-2 text-right font-medium">Margin %</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((p) => {
            const margin = p.margin ? Number(p.margin) : null;
            const marginTone =
              margin === null ? null : margin >= 0 ? "text-emerald-700" : "text-red-700";
            const isFp = p.billing_model === "fixed_price";
            const pctComplete =
              p.pct_complete != null ? Number(p.pct_complete) : null;
            const pctLabel =
              pctComplete != null ? `${(pctComplete * 100).toFixed(0)}%` : null;
            return (
              <tr key={p.project_id} className="hover:bg-muted/20">
                <td className="px-3 py-2">
                  <Link
                    href={`/projects/${p.project_id}`}
                    className="hover:underline"
                  >
                    <span className="text-muted-foreground">{p.customer_name}</span>
                    <span className="text-muted-foreground"> / </span>
                    <span>{p.project_name}</span>
                  </Link>
                  {p.over_budget && (
                    <span
                      className="ml-2 inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-800"
                      title={`Burned ${pctLabel ?? "100%+"} of time budget — recognized revenue capped at agreed amount.`}
                    >
                      <AlertTriangle className="h-3 w-3" />
                      over
                    </span>
                  )}
                  {p.n_missing_freelancer_hours_months !== undefined &&
                    p.n_missing_freelancer_hours_months > 0 && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
                        title="Months since project start where a freelancer assignment was active but no time entry has been logged."
                      >
                        {p.n_missing_freelancer_hours_months} month
                        {p.n_missing_freelancer_hours_months === 1 ? "" : "s"}{" "}
                        missing hours
                      </span>
                    )}
                </td>
                <td className="px-3 py-2">
                  <Badge
                    variant="outline"
                    title={
                      isFp && p.recognition_method
                        ? p.recognition_method === "tracked_hours"
                          ? `FP revenue recognized via tracked hours${pctLabel ? ` (${pctLabel} complete)` : ""}`
                          : p.recognition_method === "timeline"
                            ? `FP revenue recognized linearly over planned window${pctLabel ? ` (${pctLabel} elapsed)` : ""}`
                            : "FP — no recognition rule set"
                        : undefined
                    }
                  >
                    {isFp ? "FP" : "T&M"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {p.n_assignments}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {p.revenue ? formatEUR(p.revenue) : "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {formatEUR(p.cost)}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", marginTone)}>
                  {p.margin ? formatEUR(p.margin) : "—"}
                </td>
                <td className={cn("px-3 py-2 text-right tabular-nums", marginTone)}>
                  {p.margin_pct ? formatPercent(p.margin_pct) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
