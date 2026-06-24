"use client";

import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";

/** Tiny 12-point sparkline for the per-row drift indicator on team and
 * role-tier rollups. Shows raw value, no axes, no labels — context
 * comes from the surrounding row. */
export function UtilizationSparkline({
  values,
  width = 80,
  height = 24,
}: {
  values: Array<number | null>;
  width?: number;
  height?: number;
}) {
  const data = values.map((v, i) => ({ i, v }));
  const valid = values.filter((v): v is number => v !== null);
  if (valid.length < 2) {
    return (
      <span
        className="inline-block text-xs text-muted-foreground"
        style={{ width, height, lineHeight: `${height}px` }}
      >
        —
      </span>
    );
  }
  // Domain padded a touch so a flat line still sits visibly inside
  // the bounds.
  const min = Math.min(...valid);
  const max = Math.max(...valid);
  const pad = (max - min) * 0.1 || 1;
  return (
    <div style={{ width, height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis hide domain={[min - pad, max + pad]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
