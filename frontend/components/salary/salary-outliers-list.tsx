"use client";

import Link from "next/link";

import type { SalaryOutlier } from "@/lib/api/salary-insights";
import { formatEUR } from "@/lib/format";
import { cn } from "@/lib/utils";

const eur = (n: number) => formatEUR(n);

export function SalaryOutliersList({ rows }: { rows: SalaryOutlier[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No employees fall above their band's upper fence or above the max of
        a higher-ranked tier.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {rows.map((r) => {
        const crossBand = r.reasons.find((x) => x.kind === "cross_band");
        const inBand = r.reasons.find((x) => x.kind === "in_band");
        return (
          <li
            key={r.employee_id}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <Link
                href={`/employees/${r.employee_id}`}
                className="text-sm font-medium hover:underline"
              >
                {r.name}
              </Link>
              <div className="text-xs text-muted-foreground">
                <span className="capitalize">{r.group_key}</span>
                {r.position ? <> · {r.position}</> : null}
              </div>
            </div>
            <div className="flex flex-col items-end gap-0.5 text-right text-xs tabular-nums">
              <span className="text-sm font-medium text-foreground">
                {eur(r.salary)}
              </span>
              {crossBand && (
                <span className={cn("text-red-700")}>
                  +{eur(crossBand.delta)} {crossBand.label}
                </span>
              )}
              {inBand && (
                <span className="text-amber-700">
                  +{eur(inBand.delta)} {inBand.label}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
