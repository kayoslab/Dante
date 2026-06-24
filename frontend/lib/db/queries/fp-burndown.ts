import Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../client";
import { germanFederalHolidays } from "../_de-holidays";
import {
  burdenFactor,
  cumulativeProjectCost,
  fmt,
  fpRecognitionThrough,
  lastOfMonth,
  projectFuturePlannedHours,
  projectTrackedHoursThrough,
  workingDaysInRange,
} from "../_monthly-helpers";

/** Per-project burn-down state shape for `/reports/fp-burndown`.
 *
 * Two recognition methods get different lenses:
 *  - `tracked_hours` projects: bar fills with tracked vs `time_budget_hours`,
 *    planned tick at `elapsed_share × budget`. Variance = tracked - elapsed.
 *  - `timeline` projects: bar fills with calendar elapsed (which is also
 *    the planned share — by definition). Variance reads from
 *    cost/recognized margin erosion in the per-row EUR strip below.
 *  - `none` (FP with no agreed amount or no recognition rule): bar
 *    suppressed; row just shows the EUR strip + a "no recognition
 *    rule" badge. */
export type FpBurndownProject = {
  project_id: number;
  project_name: string;
  customer_id: number;
  customer_name: string;
  recognition_method: "tracked_hours" | "timeline" | "none";
  agreed_amount: string | null;
  time_budget_hours: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
  /** Date the as-of snapshot is taken — `min(today, last day of selected month)`. */
  as_of_date: string;
  /** Cumulative tracked hours on this project through `as_of_date`. */
  tracked_hours: string;
  /** Cumulative loaded payroll cost on this project through `as_of_date`. */
  cumulative_cost: string;
  /** Cumulative recognized revenue through `as_of_date`. */
  cumulative_recognized: string;
  /** tracked_hours / time_budget_hours, capped UI-side. Null when no time budget. */
  tracked_pct: string | null;
  /** Future planned hours from `as_of_date` to `planned_end_date` —
   * sum of `(working_days × allocation_pct × standard_daily_hours)` across
   * every assignment on the project that overlaps the future window.
   * Null when no plan / no time budget. */
  future_planned_hours: string | null;
  /** (tracked_hours + future_planned_hours) / time_budget_hours — where
   * we'll land at project end if current allocations are honored. The
   * bar's tick draws here. Null for non-tracked projects. Can exceed 1.0
   * — that's the "we'll overrun" signal. */
  projected_pct: string | null;
  /** Working-day elapsed share of the planned window, 0–1. Kept for
   * timeline-method projects (they fill the bar with this). Tracked
   * projects don't read it any more. Null when no plan. */
  elapsed_pct: string | null;
  /** (projected_pct - 1.0) × 100 for tracked_hours projects.
   * Positive = projected overrun. Null for non-tracked projects. */
  variance_pp: string | null;
  /** (cost - recognized) / recognized × 100, for timeline projects only.
   * Positive = margin eroding (spending more than recognizing). Null for tracked. */
  margin_erosion_pct: string | null;
  status:
    | "on_track"
    | "at_risk"
    | "time_exhausted"
    | "margin_negative"
    | "not_started"
    | "ended"
    | "no_rule";
  /** Working days from `as_of_date` to `planned_end_date`; null when no plan
   * or end_date already passed. */
  days_to_end: number | null;
};

export type FpBurndownMonth = {
  month: string;
  as_of_date: string;
  projects: FpBurndownProject[];
  summary: {
    n_active: number;
    /** Projects where cumulative cost exceeds cumulative recognized revenue
     * — actually losing money so far. */
    n_margin_negative: number;
    /** Projects whose tracked hours have hit the time budget — recognition
     * is capped, but margin may still be positive. */
    n_time_exhausted: number;
    n_at_risk: number;
    total_agreed: string;
    total_recognized: string;
    total_cost: string;
  };
};

type RawFpProject = {
  project_id: number;
  project_name: string;
  customer_id: number;
  customer_name: string;
  agreed_amount: string | null;
  time_budget_hours: number | null;
  planned_start_date: string | null;
  planned_end_date: string | null;
};

/** FP projects that had ANY activity in the selected month — either an
 * assignment overlapping the window, or a planned start/end span that
 * crosses the month. Status is intentionally not filtered: a project
 * that wrapped up in Q1 should still appear when you navigate to a
 * month it was running in. Per-row numbers are computed as-of today,
 * so the month picker only filters which projects show, not their
 * burn state. */
async function listFpProjectsInMonth(monthYm: string): Promise<RawFpProject[]> {
  const month_start = `${monthYm}-01`;
  const month_end = lastOfMonth(month_start);
  const r = await db.execute(sql`
    SELECT DISTINCT p.project_id,
           p.name AS project_name,
           c.customer_id,
           c.name AS customer_name,
           p.agreed_amount_eur,
           p.time_budget_hours,
           p.planned_start_date,
           p.planned_end_date
    FROM project p
    JOIN customer c ON c.customer_id = p.customer_id
    WHERE p.billing_model = 'fixed_price'
      AND (
        EXISTS (
          SELECT 1 FROM assignment a
          WHERE a.project_id = p.project_id
            AND a.start_date <= ${month_end}::date
            AND (a.end_date IS NULL OR a.end_date >= ${month_start}::date)
        )
        OR (
          p.planned_start_date IS NOT NULL
          AND p.planned_end_date IS NOT NULL
          AND p.planned_start_date <= ${month_end}::date
          AND p.planned_end_date >= ${month_start}::date
        )
      )
    ORDER BY c.name, p.name
  `);
  return (r.rows as Array<Record<string, unknown>>).map((row) => ({
    project_id: Number(row.project_id),
    project_name: row.project_name as string,
    customer_id: Number(row.customer_id),
    customer_name: row.customer_name as string,
    agreed_amount:
      row.agreed_amount_eur === null || row.agreed_amount_eur === undefined
        ? null
        : (row.agreed_amount_eur as string),
    time_budget_hours:
      row.time_budget_hours === null || row.time_budget_hours === undefined
        ? null
        : Number(row.time_budget_hours),
    planned_start_date: (row.planned_start_date as string | null) ?? null,
    planned_end_date: (row.planned_end_date as string | null) ?? null,
  }));
}

function pickRecognitionMethod(
  p: RawFpProject,
): "tracked_hours" | "timeline" | "none" {
  if (p.agreed_amount === null || Number(p.agreed_amount) <= 0) return "none";
  if (p.time_budget_hours !== null && p.time_budget_hours > 0) {
    return "tracked_hours";
  }
  if (
    p.planned_start_date !== null &&
    p.planned_end_date !== null &&
    p.planned_end_date >= p.planned_start_date
  ) {
    return "timeline";
  }
  return "none";
}

/** Working-day elapsed share of the project's planned window, clipped at
 * `as_of_date`. Null when no plan or the window is degenerate. */
function elapsedWorkingDaysShare(
  planned_start: string | null,
  planned_end: string | null,
  as_of: string,
): { share: Decimal; days_to_end: number | null } | null {
  if (planned_start === null || planned_end === null) return null;
  if (planned_end < planned_start) return null;
  const yStart = Number(planned_start.slice(0, 4));
  const yEnd = Number(planned_end.slice(0, 4));
  const holidays = germanFederalHolidays(yStart, yEnd);
  const all = workingDaysInRange(planned_start, planned_end, holidays);
  if (all.length === 0) return null;
  const clipped_end = as_of < planned_end ? as_of : planned_end;
  if (clipped_end < planned_start) {
    return { share: new Decimal(0), days_to_end: all.length };
  }
  const elapsed = all.filter((d) => d <= clipped_end).length;
  const share = new Decimal(elapsed).div(all.length);
  const days_to_end = as_of < planned_end ? all.length - elapsed : 0;
  return { share, days_to_end };
}

async function computeProjectBurndown(
  p: RawFpProject,
  as_of: string,
  burden: number,
): Promise<FpBurndownProject> {
  const recognition_method = pickRecognitionMethod(p);
  const agreed =
    p.agreed_amount === null ? null : new Decimal(p.agreed_amount);

  // Each cumulative number is "through end of as_of date". For a future
  // project (planned_start > as_of), as_of stays — the helpers return 0
  // naturally because no assignments overlap. Future-planned hours
  // looks the OTHER direction — from as_of forward to planned_end.
  const [trackedHours, futurePlannedHours, cost, recognition] =
    await Promise.all([
      projectTrackedHoursThrough(p.project_id, as_of),
      projectFuturePlannedHours(p.project_id, as_of, p.planned_end_date),
      cumulativeProjectCost(p.project_id, as_of, burden),
      fpRecognitionThrough(
        p.project_id,
        as_of,
        agreed,
        p.time_budget_hours,
        p.planned_start_date,
        p.planned_end_date,
      ),
    ]);
  const recognized = recognition.cumulative_recognized ?? new Decimal(0);

  const elapsed = elapsedWorkingDaysShare(
    p.planned_start_date,
    p.planned_end_date,
    as_of,
  );

  let tracked_pct: Decimal | null = null;
  let projected_pct: Decimal | null = null;
  if (p.time_budget_hours !== null && p.time_budget_hours > 0) {
    tracked_pct = trackedHours.div(p.time_budget_hours);
    projected_pct = trackedHours
      .add(futurePlannedHours)
      .div(p.time_budget_hours);
  }

  let variance_pp: Decimal | null = null;
  let margin_erosion_pct: Decimal | null = null;
  if (recognition_method === "tracked_hours" && projected_pct !== null) {
    // Projected overrun. Positive = projected to land above 100%.
    variance_pp = projected_pct.sub(1).mul(100);
  } else if (recognition_method === "timeline" && recognized.gt(0)) {
    // Spending > recognizing = margin erosion. Negative means we're
    // spending less than recognizing (healthy margin).
    margin_erosion_pct = cost.sub(recognized).div(recognized).mul(100);
  }

  // Status — precedence: margin_negative > time_exhausted > at_risk >
  // on_track. The three "watch" states are independent signals:
  //  - margin_negative: cumulative cost > cumulative recognized → we're
  //    actually losing money so far. Worst state.
  //  - time_exhausted: tracked >= time_budget → recognition is capped at
  //    agreed_amount; no more revenue is reachable. Doesn't necessarily
  //    mean we're losing money (the project page's "Remaining budget"
  //    can still be positive if cost stayed under agreed_amount).
  //  - at_risk: tracked variance > 10pp (tracked method) or cost vs
  //    recognized margin erosion > 10pp (timeline method). Trending
  //    bad but not yet there.
  let status: FpBurndownProject["status"];
  const margin_negative =
    recognized.gt(0) && cost.gt(recognized);
  if (recognition_method === "none") {
    status = "no_rule";
  } else if (
    p.planned_start_date !== null &&
    as_of < p.planned_start_date
  ) {
    status = "not_started";
  } else if (
    p.planned_end_date !== null &&
    as_of > p.planned_end_date
  ) {
    status = "ended";
  } else if (margin_negative) {
    status = "margin_negative";
  } else if (recognition_method === "tracked_hours") {
    const tracked = tracked_pct ?? new Decimal(0);
    const v = variance_pp ?? new Decimal(0);
    if (tracked.gte(1)) status = "time_exhausted";
    else if (v.gt(10)) status = "at_risk";
    else status = "on_track";
  } else {
    // timeline
    const e = margin_erosion_pct ?? new Decimal(0);
    if (e.gt(10)) status = "at_risk";
    else status = "on_track";
  }

  return {
    project_id: p.project_id,
    project_name: p.project_name,
    customer_id: p.customer_id,
    customer_name: p.customer_name,
    recognition_method,
    agreed_amount: agreed === null ? null : fmt(agreed, 2),
    time_budget_hours: p.time_budget_hours,
    planned_start_date: p.planned_start_date,
    planned_end_date: p.planned_end_date,
    as_of_date: as_of,
    tracked_hours: fmt(trackedHours, 2),
    cumulative_cost: fmt(cost, 2),
    cumulative_recognized: fmt(recognized, 2),
    tracked_pct: tracked_pct === null ? null : fmt(tracked_pct, 4),
    future_planned_hours:
      p.time_budget_hours === null || p.time_budget_hours <= 0
        ? null
        : fmt(futurePlannedHours, 2),
    projected_pct: projected_pct === null ? null : fmt(projected_pct, 4),
    elapsed_pct: elapsed === null ? null : fmt(elapsed.share, 4),
    variance_pp: variance_pp === null ? null : fmt(variance_pp, 2),
    margin_erosion_pct:
      margin_erosion_pct === null ? null : fmt(margin_erosion_pct, 2),
    status,
    days_to_end: elapsed?.days_to_end ?? null,
  };
}

const STATUS_RANK: Record<FpBurndownProject["status"], number> = {
  margin_negative: 0,
  time_exhausted: 1,
  at_risk: 2,
  on_track: 3,
  not_started: 4,
  ended: 5,
  no_rule: 6,
};

export async function computeFpBurndownForMonth(
  monthYm: string,
  todayIso: string,
): Promise<FpBurndownMonth> {
  // The month selector filters which projects appear (active in that
  // month). Per-project numbers always reflect "as of today" — burn,
  // remaining budget, and future planned allocations are real-time
  // figures, not historical snapshots. Navigating months never rewinds
  // the cost/tracked state.
  const as_of = todayIso;

  const burden = await burdenFactor();
  const projects = await listFpProjectsInMonth(monthYm);
  const rows = await Promise.all(
    projects.map((p) => computeProjectBurndown(p, as_of, burden)),
  );

  rows.sort((a, b) => {
    const sa = STATUS_RANK[a.status];
    const sb = STATUS_RANK[b.status];
    if (sa !== sb) return sa - sb;
    // Within same status group, biggest variance first (most urgent at top).
    const va =
      a.variance_pp !== null
        ? Number(a.variance_pp)
        : a.margin_erosion_pct !== null
          ? Number(a.margin_erosion_pct)
          : 0;
    const vb =
      b.variance_pp !== null
        ? Number(b.variance_pp)
        : b.margin_erosion_pct !== null
          ? Number(b.margin_erosion_pct)
          : 0;
    return vb - va;
  });

  const summary = rows.reduce(
    (acc, r) => {
      acc.n_active += 1;
      if (r.status === "margin_negative") acc.n_margin_negative += 1;
      if (r.status === "time_exhausted") acc.n_time_exhausted += 1;
      if (r.status === "at_risk") acc.n_at_risk += 1;
      acc.total_agreed = acc.total_agreed.add(
        r.agreed_amount === null ? 0 : r.agreed_amount,
      );
      acc.total_recognized = acc.total_recognized.add(r.cumulative_recognized);
      acc.total_cost = acc.total_cost.add(r.cumulative_cost);
      return acc;
    },
    {
      n_active: 0,
      n_margin_negative: 0,
      n_time_exhausted: 0,
      n_at_risk: 0,
      total_agreed: new Decimal(0),
      total_recognized: new Decimal(0),
      total_cost: new Decimal(0),
    },
  );

  return {
    month: monthYm,
    as_of_date: as_of,
    projects: rows,
    summary: {
      n_active: summary.n_active,
      n_margin_negative: summary.n_margin_negative,
      n_time_exhausted: summary.n_time_exhausted,
      n_at_risk: summary.n_at_risk,
      total_agreed: fmt(summary.total_agreed, 2),
      total_recognized: fmt(summary.total_recognized, 2),
      total_cost: fmt(summary.total_cost, 2),
    },
  };
}
