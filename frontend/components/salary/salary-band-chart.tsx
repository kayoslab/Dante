"use client";

import type { SalaryBandRow } from "@/lib/api/salary-insights";
import { formatEUR } from "@/lib/format";

const eur = (n: number) => formatEUR(n);

/**
 * Horizontal box-and-whisker chart: one row per group_key. Each row shows
 * min/max as whisker lines, p25-p75 as the filled box, and the median as
 * a thick vertical bar inside. All grouped onto a shared x-scale (EUR).
 *
 * Built as SVG because recharts has no native box plot. Layout is
 * deterministic — width fits the parent via 100% SVG; we set viewBox to a
 * stable 0..1000 horizontal so positions are easy to reason about.
 */
export function SalaryBandChart({ rows }: { rows: SalaryBandRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No data for this grouping yet.
      </p>
    );
  }
  // Shared x scale across all groups: 0 → max-of-max with 5% padding.
  const xMax = Math.max(...rows.map((r) => r.max)) * 1.05;
  // 5 nice ticks
  const niceStep = niceTickStep(xMax / 5);
  const ticks: number[] = [];
  for (let v = 0; v <= xMax; v += niceStep) ticks.push(v);

  const ROW_H = 44;
  const PAD_TOP = 28;
  const PAD_BOTTOM = 8;
  const PAD_LEFT = 160; // room for group labels
  const PAD_RIGHT = 16;
  const PLOT_W = 1000 - PAD_LEFT - PAD_RIGHT;
  const SVG_H = PAD_TOP + rows.length * ROW_H + PAD_BOTTOM;

  const x = (v: number) => PAD_LEFT + (v / xMax) * PLOT_W;
  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 1000 ${SVG_H}`}
        className="h-auto w-full min-w-[600px]"
        role="img"
        aria-label="Salary distribution box plot"
      >
        {/* X-axis ticks + labels */}
        {ticks.map((v) => (
          <g key={`tick-${v}`}>
            <line
              x1={x(v)}
              x2={x(v)}
              y1={PAD_TOP - 4}
              y2={SVG_H - PAD_BOTTOM}
              stroke="currentColor"
              strokeOpacity={0.08}
            />
            <text
              x={x(v)}
              y={PAD_TOP - 10}
              fontSize={10}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.6}
            >
              {v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`}
            </text>
          </g>
        ))}

        {rows.map((r, i) => {
          const yMid = PAD_TOP + i * ROW_H + ROW_H / 2;
          const boxY = yMid - 12;
          const boxH = 24;
          return (
            <g key={r.group_key ?? `row-${i}`}>
              {/* Group label */}
              <text
                x={PAD_LEFT - 12}
                y={yMid + 4}
                fontSize={12}
                textAnchor="end"
                fill="currentColor"
              >
                {r.group_key}
              </text>
              <text
                x={PAD_LEFT - 12}
                y={yMid + 18}
                fontSize={10}
                textAnchor="end"
                fill="currentColor"
                fillOpacity={0.55}
              >
                n={r.n}
              </text>

              {/* Whisker line (min to max) */}
              <line
                x1={x(r.min)}
                x2={x(r.max)}
                y1={yMid}
                y2={yMid}
                stroke="currentColor"
                strokeOpacity={0.4}
                strokeWidth={1.5}
              />
              {/* Whisker caps */}
              <line
                x1={x(r.min)}
                x2={x(r.min)}
                y1={yMid - 8}
                y2={yMid + 8}
                stroke="currentColor"
                strokeOpacity={0.5}
              />
              <line
                x1={x(r.max)}
                x2={x(r.max)}
                y1={yMid - 8}
                y2={yMid + 8}
                stroke="currentColor"
                strokeOpacity={0.5}
              />
              {/* IQR box (p25 → p75) */}
              <rect
                x={x(r.p25)}
                y={boxY}
                width={Math.max(2, x(r.p75) - x(r.p25))}
                height={boxH}
                fill="hsl(217 91% 60% / 0.18)"
                stroke="hsl(217 91% 60%)"
                strokeWidth={1}
                rx={2}
              />
              {/* Median line */}
              <line
                x1={x(r.median)}
                x2={x(r.median)}
                y1={boxY}
                y2={boxY + boxH}
                stroke="hsl(217 91% 60%)"
                strokeWidth={2.5}
              />
              {/* Hover-only tooltips via <title> on the whole row */}
              <title>
                {`${r.group_key} (n=${r.n})\n`}
                {`min ${eur(r.min)}\n`}
                {`p25 ${eur(r.p25)}\n`}
                {`median ${eur(r.median)}\n`}
                {`p75 ${eur(r.p75)}\n`}
                {`max ${eur(r.max)}`}
              </title>
            </g>
          );
        })}
      </svg>
      {/* Compact numeric table beneath so the values aren't hidden behind hover. */}
      <div className="mt-3 overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Group</th>
              <th className="px-3 py-2 text-right font-medium">n</th>
              <th className="px-3 py-2 text-right font-medium">min</th>
              <th className="px-3 py-2 text-right font-medium">p25</th>
              <th className="px-3 py-2 text-right font-medium">median</th>
              <th className="px-3 py-2 text-right font-medium">p75</th>
              <th className="px-3 py-2 text-right font-medium">max</th>
              <th className="px-3 py-2 text-right font-medium">IQR</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((r) => (
              <tr key={r.group_key ?? "?"} className="hover:bg-muted/20">
                <td className="px-3 py-2">{r.group_key ?? "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.n}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {eur(r.min)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {eur(r.p25)}
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {eur(r.median)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {eur(r.p75)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {eur(r.max)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                  {eur(r.p75 - r.p25)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function niceTickStep(rough: number): number {
  // Round `rough` up to a "nice" 1/2/5×10ⁿ value.
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const ratio = rough / mag;
  if (ratio <= 1) return mag;
  if (ratio <= 2) return 2 * mag;
  if (ratio <= 5) return 5 * mag;
  return 10 * mag;
}
