/** Personio v1 /company/time-offs → canonical absences. */
import type { CanonicalAbsence } from "@/lib/integrations/core/types";

import { coerceDate, coerceNumber, envelopeEmployeeId } from "./helpers";

export function flattenAbsence(item: unknown): CanonicalAbsence | null {
  const attrs = (item as { attributes?: Record<string, unknown> }).attributes ?? {};
  const id = attrs.id;
  const employee_id = envelopeEmployeeId(attrs.employee);
  const start_date = coerceDate(attrs.start_date);
  const end_date = coerceDate(attrs.end_date);
  if (id === null || id === undefined || employee_id === null || !start_date || !end_date) {
    return null;
  }
  const typeObj = attrs.time_off_type as { attributes?: { name?: string } } | undefined;
  const half = (v: unknown): boolean | null => (v === null || v === undefined ? null : Boolean(v));
  return {
    external_id: String(id),
    external_person_id: String(employee_id),
    type_name: typeObj?.attributes?.name ?? null,
    start_date,
    end_date,
    half_day_start: half(attrs.half_day_start),
    half_day_end: half(attrs.half_day_end),
    days_count: coerceNumber(attrs.days_count),
    status: (attrs.status as string | undefined) ?? null,
    comment: (attrs.comment as string | undefined) || null,
  };
}
