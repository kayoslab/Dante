/** Salary-field resolution between a `compensation_event` as-of row and
 * the `employee_current` "now" row. Split out of `_monthly-helpers.ts`
 * so the unit tests can exercise it without pulling the DB client
 * down the import chain.
 *
 * Personio's `compensation_event` rows are usually salary deltas: the
 * field that changed carries the new value, the rest are left NULL on
 * the assumption "unchanged from current." Treating NULL as zero was
 * the original bug — an hourly comp event with `weekly_working_hours
 * = NULL` resolved to "no salary on file" even though
 * `employee_current.weekly_working_hours` had the right value.
 *
 * The category (FIXED vs HOURLY) is NOT a delta — it tells us which
 * compensation kind the latest event picked. We honor it even when
 * employee_current still has a stale value for the other kind. */

export type SalaryRow = {
  fix_salary: unknown;
  fix_salary_interval: unknown;
  hourly_salary: unknown;
  weekly_working_hours: unknown;
  asof_category: unknown;
  asof_amount: unknown;
  asof_interval: unknown;
  asof_wkh: unknown;
};

export type ResolvedSalary = {
  fix: number | null;
  interval: string | null;
  hourly: number | null;
  wkh: number | null;
  asofUsed: boolean;
};

export function resolveSalaryFromRow(row: SalaryRow): ResolvedSalary {
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : (v as string);

  const currFix = num(row.fix_salary);
  const currInterval = str(row.fix_salary_interval);
  const currHourly = num(row.hourly_salary);
  const currWkh = num(row.weekly_working_hours);
  const asofCategory = str(row.asof_category);

  if (asofCategory === "FIXED_SALARY") {
    const asofInterval = str(row.asof_interval);
    const effInterval = asofInterval ?? currInterval;
    return {
      fix: num(row.asof_amount),
      interval: effInterval === null ? null : effInterval.toLowerCase(),
      hourly: null,
      wkh: num(row.asof_wkh) ?? currWkh,
      asofUsed: true,
    };
  }
  if (asofCategory === "HOURLY_SALARY") {
    return {
      fix: null,
      interval: null,
      hourly: num(row.asof_amount),
      wkh: num(row.asof_wkh) ?? currWkh,
      asofUsed: true,
    };
  }
  return {
    fix: currFix,
    interval: currInterval,
    hourly: currHourly,
    wkh: currWkh,
    asofUsed: false,
  };
}
