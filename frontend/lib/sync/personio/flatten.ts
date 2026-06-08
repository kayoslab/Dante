/** Flatten a Personio v1 /employees record into an employee_current row.
 *
 * Personio attributes are wrapped as `{ value: <v>, type, label }`. `<v>`
 * can be a scalar, a nested object (Department/Office/Employee), or a list
 * (cost_centers). Port of src/dante/sync.py::flatten_employee.
 */
import {
  CUSTOM_ATTRIBUTES,
  EMPLOYEE_COLUMNS,
  isDateColumn,
  isNumericColumn,
  JSON_COLUMNS,
  STANDARD_ATTRIBUTES,
  type EmployeeColumn,
} from "./attribute-map";

type Attr = { value?: unknown };

function extract(attr: Attr): unknown {
  const value = attr.value;
  if (value === null || value === undefined || value === "") return null;

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const first = value[0];
    if (first && typeof first === "object") {
      const inner = (first as { attributes?: Record<string, unknown> })
        .attributes ?? {};
      const name = inner.name;
      if (name && typeof name === "object") {
        return (name as { value?: unknown }).value ?? null;
      }
      return name ?? null;
    }
    return null;
  }

  if (value && typeof value === "object" && "attributes" in value) {
    const nested = (value as { attributes: Record<string, unknown> })
      .attributes;
    if ("name" in nested) {
      const name = nested.name;
      if (name && typeof name === "object") {
        return (name as { value?: unknown }).value ?? null;
      }
      return name ?? null;
    }
    if ("id" in nested) {
      const ident = nested.id;
      if (ident && typeof ident === "object") {
        return (ident as { value?: unknown }).value ?? null;
      }
      return ident ?? null;
    }
    return null;
  }

  return value;
}

function supervisorId(attr: Attr): unknown {
  const value = attr.value;
  if (value && typeof value === "object" && "attributes" in value) {
    const ident = (value as { attributes: Record<string, unknown> }).attributes
      .id;
    if (ident && typeof ident === "object") {
      return (ident as { value?: unknown }).value ?? null;
    }
    return ident ?? null;
  }
  return null;
}

function coerceDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export type EmployeeRow = Record<EmployeeColumn, unknown>;

export function flattenEmployee(employee: unknown): EmployeeRow {
  const attrs = ((employee as { attributes?: Record<string, Attr> }).attributes
    ?? {}) as Record<string, Attr>;
  const row = {} as EmployeeRow;
  for (const col of EMPLOYEE_COLUMNS) row[col] = null;

  for (const [key, column] of Object.entries(STANDARD_ATTRIBUTES)) {
    if (!(key in attrs)) continue;
    const col = column as EmployeeColumn;
    if (column === "supervisor_id") {
      row[col] = supervisorId(attrs[key]);
    } else if (JSON_COLUMNS.has(column)) {
      const raw = attrs[key].value;
      row[col] = raw ?? null;
    } else {
      row[col] = extract(attrs[key]);
    }
  }

  for (const [key, column] of Object.entries(CUSTOM_ATTRIBUTES)) {
    if (key in attrs) row[column as EmployeeColumn] = extract(attrs[key]);
  }

  for (const col of EMPLOYEE_COLUMNS) {
    if (isDateColumn(col)) row[col] = coerceDate(row[col]);
    if (isNumericColumn(col)) row[col] = coerceNumber(row[col]);
  }
  return row;
}

/** Pick the actual leaving date from a v2 /persons/{id}/employments response.
 * Prefers ACTIVE records; among multiple, latest employment_start_date wins
 * (handles re-hires). */
export function pickEmploymentEndDate(employments: unknown[]): string | null {
  if (employments.length === 0) return null;
  type Emp = {
    status?: string;
    employment_start_date?: string;
    employment_end_date?: string;
  };
  const active = (employments as Emp[]).filter(
    (e) => (e.status ?? "").toUpperCase() === "ACTIVE",
  );
  const pool = active.length > 0 ? active : (employments as Emp[]);
  pool.sort((a, b) =>
    (b.employment_start_date ?? "").localeCompare(a.employment_start_date ?? ""),
  );
  return coerceDate(pool[0].employment_end_date);
}
