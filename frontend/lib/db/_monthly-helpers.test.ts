import { test } from "node:test";
import { strict as assert } from "node:assert";

import { resolveSalaryFromRow } from "./_salary-resolve";

const base = {
  fix_salary: null,
  fix_salary_interval: null,
  hourly_salary: null,
  weekly_working_hours: null,
  asof_category: null,
  asof_amount: null,
  asof_interval: null,
  asof_wkh: null,
};

test("no asof event → falls back to employee_current 'now' values", () => {
  const r = resolveSalaryFromRow({
    ...base,
    fix_salary: "67020",
    fix_salary_interval: "yearly",
    weekly_working_hours: 40,
  });
  assert.equal(r.fix, 67020);
  assert.equal(r.interval, "yearly");
  assert.equal(r.hourly, null);
  assert.equal(r.wkh, 40);
  assert.equal(r.asofUsed, false);
});

test("FIXED_SALARY event fully populated → all fields from event", () => {
  const r = resolveSalaryFromRow({
    ...base,
    fix_salary: "60000",
    fix_salary_interval: "yearly",
    weekly_working_hours: 38,
    asof_category: "FIXED_SALARY",
    asof_amount: "67020",
    asof_interval: "YEARLY",
    asof_wkh: 40,
  });
  assert.equal(r.fix, 67020);
  assert.equal(r.interval, "yearly", "uppercase Personio interval lowercased");
  assert.equal(r.wkh, 40);
  assert.equal(r.asofUsed, true);
});

test("FIXED_SALARY event missing interval → falls back to employee_current interval", () => {
  const r = resolveSalaryFromRow({
    ...base,
    fix_salary: "60000",
    fix_salary_interval: "monthly",
    weekly_working_hours: 40,
    asof_category: "FIXED_SALARY",
    asof_amount: "67020",
    asof_interval: null,
    asof_wkh: 40,
  });
  assert.equal(r.fix, 67020, "event amount honored");
  assert.equal(r.interval, "monthly", "interval falls back");
  assert.equal(r.wkh, 40);
});

test("FIXED_SALARY event missing wkh → falls back to employee_current wkh", () => {
  const r = resolveSalaryFromRow({
    ...base,
    fix_salary: "60000",
    fix_salary_interval: "yearly",
    weekly_working_hours: 40,
    asof_category: "FIXED_SALARY",
    asof_amount: "67020",
    asof_interval: "YEARLY",
    asof_wkh: null,
  });
  assert.equal(r.fix, 67020);
  assert.equal(r.interval, "yearly");
  assert.equal(r.wkh, 40, "wkh falls back when event omits it");
});

test("HOURLY_SALARY event fully populated → all fields from event", () => {
  const r = resolveSalaryFromRow({
    ...base,
    hourly_salary: "18",
    weekly_working_hours: 20,
    asof_category: "HOURLY_SALARY",
    asof_amount: "20",
    asof_wkh: 30,
  });
  assert.equal(r.fix, null);
  assert.equal(r.interval, null);
  assert.equal(r.hourly, 20);
  assert.equal(r.wkh, 30);
  assert.equal(r.asofUsed, true);
});

test("HOURLY_SALARY event missing wkh → falls back to employee_current wkh (Simon Kalytta repro)", () => {
  // The actual data Personio synced for employee 21436018: HOURLY_SALARY
  // event with amount=20, weekly_working_hours=NULL. employee_current has
  // weekly_working_hours=20. Pre-fix the function dropped wkh to null and
  // the caller reported "no salary on file" — even though both 20s are
  // present on the row.
  const r = resolveSalaryFromRow({
    ...base,
    hourly_salary: "20",
    weekly_working_hours: 20,
    asof_category: "HOURLY_SALARY",
    asof_amount: "20",
    asof_wkh: null,
  });
  assert.equal(r.hourly, 20);
  assert.equal(r.wkh, 20, "wkh falls back so caller can compute hourly cost");
  assert.equal(r.asofUsed, true);
});

test("HOURLY_SALARY event with explicit wkh=0 is honored as zero, not bridged from current", () => {
  // 0 means "no hours scheduled" — distinct from NULL. The fallback path
  // only kicks in for NULL.
  const r = resolveSalaryFromRow({
    ...base,
    weekly_working_hours: 40,
    asof_category: "HOURLY_SALARY",
    asof_amount: "20",
    asof_wkh: 0,
  });
  assert.equal(r.wkh, 0);
});

test("asof category overrides current — hourly event hides leftover fix_salary on employee_current", () => {
  const r = resolveSalaryFromRow({
    ...base,
    fix_salary: "60000",
    fix_salary_interval: "yearly",
    asof_category: "HOURLY_SALARY",
    asof_amount: "25",
    asof_wkh: 20,
  });
  assert.equal(r.fix, null, "fix dropped — latest comp is hourly");
  assert.equal(r.hourly, 25);
});
