import { z } from "zod";

/** Treats "", null, undefined, and non-finite inputs as undefined.
 *  Use with .input/.output generics on useForm. */
const toFiniteOrUndefined = (v: unknown): number | undefined => {
  if (v === "" || v === null || v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export const optionalInt = z.preprocess(
  toFiniteOrUndefined,
  z.number().int().positive().optional(),
);

export const optionalPositiveNumber = z.preprocess(
  toFiniteOrUndefined,
  z.number().positive().optional(),
);

export const requiredPositiveNumber = z.preprocess(
  toFiniteOrUndefined,
  z.number().positive(),
);

/** Imperative coercion for `watch()` output (which is the input type). */
export function toNumberOrNull(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
