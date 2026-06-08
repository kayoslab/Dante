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

export function germanFederalHolidays(
  fromYear: number,
  toYear: number,
): Map<string, string> {
  const result = new Map<string, string>();
  const h = new Holidays("DE");
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
