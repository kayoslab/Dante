import Holidays from "date-holidays";

type RawHoliday = {
  date: string;
  name: string;
  type: string;
};

const PYTHON_NAME_OVERRIDES: Record<string, string> = {
  Maifeiertag: "Erster Mai",
  "1. Weihnachtstag": "Erster Weihnachtstag",
  "2. Weihnachtstag": "Zweiter Weihnachtstag",
};

/** Default state for employees whose `office` field is missing, blank,
 * "Homeoffice", a foreign country, or otherwise unrecognized.
 *
 * the original operator is registered in NRW; this is the safe fallback
 * for any active employee whose office is stale data (the live DB still
 * has Homeoffice rows that should have a federal state set in Personio).
 *
 * Freelancers — who never have an office — keep their null state via
 * `stateCodeForOffice` getting passed undefined upstream; this default
 * only applies when `stateCodeForOffice` is actually called for an
 * employee row. */
const DEFAULT_EMPLOYEE_STATE_CODE = "NW";

/** Map of `employee_current.office` values → ISO 3166-2 German subdivision
 * code recognized by the `date-holidays` library. Values come from the
 * live `office` column (production data, surveyed June 2026).
 *
 * The map covers:
 *   - All 16 federal states by German name (with and without hyphens,
 *     since the live data is inconsistent — "Baden Württemberg" vs.
 *     "Baden-Württemberg").
 *   - City-as-office aliases that imply a state (Düsseldorf → NW).
 *
 * "Homeoffice", foreign offices, and anything not in the map fall back
 * to `DEFAULT_EMPLOYEE_STATE_CODE` (NW) — see comment there. */
const OFFICE_TO_STATE_CODE: Record<string, string> = {
  // 16 federal states.
  "Baden-Württemberg": "BW",
  "Baden Württemberg": "BW",
  Bayern: "BY",
  Berlin: "BE",
  Brandenburg: "BB",
  Bremen: "HB",
  Hamburg: "HH",
  Hessen: "HE",
  "Mecklenburg-Vorpommern": "MV",
  Niedersachsen: "NI",
  NRW: "NW",
  "Nordrhein-Westfalen": "NW",
  "Rheinland-Pfalz": "RP",
  "Rheinland Pfalz": "RP",
  Saarland: "SL",
  Sachsen: "SN",
  "Sachsen-Anhalt": "ST",
  "Schleswig-Holstein": "SH",
  "Schleswig Holstein": "SH",
  Thüringen: "TH",

  // City-as-office aliases.
  Düsseldorf: "NW",
  Münster: "NW",
};

/** Resolve an `office` string to a state code. Returns `null` only when
 * the caller passes `null` / `undefined` (i.e. no office concept — used
 * by freelancers). For any other input the function falls back to NRW
 * (`DEFAULT_EMPLOYEE_STATE_CODE`) — stale "Homeoffice" data, foreign
 * offices, typos, etc. all resolve to NW so cost/calendar calcs apply
 * a consistent calendar instead of silently treating an employee as
 * having no holidays. */
export function stateCodeForOffice(
  office: string | null | undefined,
): string | null {
  if (office === null || office === undefined) return null;
  if (office in OFFICE_TO_STATE_CODE) return OFFICE_TO_STATE_CODE[office];
  return DEFAULT_EMPLOYEE_STATE_CODE;
}

/** Build a date → name map for the German federal public holidays.
 *
 * Use this when you don't have an employee's office. For per-employee
 * lookups, prefer `germanHolidaysForState`. */
export function germanFederalHolidays(
  fromYear: number,
  toYear: number,
): Map<string, string> {
  return collectHolidays(new Holidays("DE"), fromYear, toYear);
}

/** Federal + state-specific public holidays for the given state code.
 *
 * State holidays not in the federal list (Fronleichnam in Bavaria, Heilige
 * Drei Könige in Bavaria/BW/SA, Mariä Himmelfahrt in Bavaria/Saarland,
 * Reformationstag in northern states, etc.) appear here but not in
 * `germanFederalHolidays` — the source of the historical "marked as
 * working day even though it's a Bavarian holiday" bug.
 *
 * `stateCode` is the ISO 3166-2 subdivision suffix (BY, NW, …). Pass
 * `null` to get federal-only — convenient when callers don't know the
 * state and want to fall back. */
export function germanHolidaysForState(
  stateCode: string | null,
  fromYear: number,
  toYear: number,
): Map<string, string> {
  const h = stateCode === null ? new Holidays("DE") : new Holidays("DE", stateCode);
  return collectHolidays(h, fromYear, toYear);
}

/** Memoized convenience for the cost calc — `germanHolidaysForState`
 * is cheap but gets called inside per-assignment loops in cumulative
 * cost helpers. Keyed by `stateCode|fromYear|toYear`; bounded by the
 * 16 states × handful of years we ever look at. */
const _holidayCache = new Map<string, Map<string, string>>();

export function germanHolidaysForStateCached(
  stateCode: string | null,
  fromYear: number,
  toYear: number,
): Map<string, string> {
  const key = `${stateCode ?? "DE"}|${fromYear}|${toYear}`;
  let m = _holidayCache.get(key);
  if (!m) {
    m = germanHolidaysForState(stateCode, fromYear, toYear);
    _holidayCache.set(key, m);
  }
  return m;
}

function collectHolidays(
  h: Holidays,
  fromYear: number,
  toYear: number,
): Map<string, string> {
  const result = new Map<string, string>();
  for (let y = fromYear; y <= toYear; y++) {
    const list = h.getHolidays(y) as RawHoliday[];
    for (const item of list) {
      if (item.type !== "public") continue;
      const isoDate = item.date.slice(0, 10);
      result.set(isoDate, PYTHON_NAME_OVERRIDES[item.name] ?? item.name);
    }
  }
  return result;
}
