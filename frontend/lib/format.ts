/** Centralized formatters. All values arrive as strings from the API
 * (Decimals serialize as strings to avoid float drift). */

const eur = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0,
});

const eurCent = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 2,
});

export function formatEUR(
  value: string | number | null | undefined,
  cents = false,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return (cents ? eurCent : eur).format(n);
}

export function formatPercent(
  value: string | number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function formatRate(value: string | number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatEUR(value, true);
}

/** "500 €/Tag" or "—". The slash between EUR amount and unit is a
 * line-break opportunity to most browsers; consumers should wrap this in a
 * `whitespace-nowrap` element so day rates don't split across lines. */
export function formatDailyRate(
  value: string | number | null | undefined,
  suffix: "/d" | "/day" = "/d",
): string {
  if (value === null || value === undefined || value === "") return "—";
  return `${formatEUR(value, true)}${suffix}`;
}
