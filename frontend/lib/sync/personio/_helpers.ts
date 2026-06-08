/** Shared low-level helpers for the Personio sync. */

export function coerceDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : null;
}

export function coerceNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Pull the integer id from a `{type: Employee, attributes: {id: {value: …}}}`
 * envelope. */
export function envelopeEmployeeId(obj: unknown): number | null {
  if (!obj || typeof obj !== "object") return null;
  const attrs = (obj as { attributes?: Record<string, unknown> }).attributes;
  if (!attrs || typeof attrs !== "object") return null;
  const ident = (attrs as { id?: unknown }).id;
  if (ident && typeof ident === "object") {
    const v = (ident as { value?: unknown }).value;
    return v === null || v === undefined ? null : Number(v);
  }
  return ident === null || ident === undefined ? null : Number(ident);
}
