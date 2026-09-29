/** Turn an adapter's `configSchema` (zod) into serialisable field
 * descriptors the settings UI can render, without shipping zod to the
 * client. Supports flat objects of string / number / boolean / enum
 * fields, optionally wrapped in `.optional()`, `.nullable()` or
 * `.default()`. Anything else is exposed as a raw JSON field so an
 * unusual schema is still editable, just less comfortably.
 */
import type { z } from "zod";

export type ConfigField = {
  key: string;
  label: string;
  description: string | null;
  type: "string" | "number" | "boolean" | "enum" | "json";
  options: string[];
  required: boolean;
  /** `.nullable()` in the schema: an empty form value posts as null. */
  nullable: boolean;
  default: unknown;
};

type ZodDef = {
  type?: string;
  innerType?: ZodLike;
  defaultValue?: unknown | (() => unknown);
  entries?: Record<string, string>;
  shape?: Record<string, ZodLike>;
};
type ZodLike = { def?: ZodDef; description?: string; shape?: Record<string, ZodLike> };

function labelOf(key: string): string {
  return key.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function describeConfigSchema(schema: z.ZodType): ConfigField[] {
  const root = schema as unknown as ZodLike;
  const shape = root.shape ?? root.def?.shape;
  if (!shape) return [];
  const fields: ConfigField[] = [];
  for (const [key, field] of Object.entries(shape)) {
    let t: ZodLike = field;
    let required = true;
    let nullable = false;
    let dflt: unknown = undefined;
    const description = field.description ?? null;
    for (;;) {
      const type = t.def?.type;
      if (type === "optional") {
        required = false;
      } else if (type === "nullable") {
        required = false;
        nullable = true;
      } else if (type === "default") {
        required = false;
        const dv = t.def?.defaultValue;
        dflt = typeof dv === "function" ? (dv as () => unknown)() : dv;
      } else {
        break;
      }
      if (!t.def?.innerType) break;
      t = t.def.innerType;
    }
    const inner = t.def?.type;
    const base = {
      key,
      label: labelOf(key),
      description: description ?? t.description ?? null,
      required,
      nullable,
      default: dflt,
    };
    if (inner === "string") fields.push({ ...base, type: "string", options: [] });
    else if (inner === "number") fields.push({ ...base, type: "number", options: [] });
    else if (inner === "boolean") fields.push({ ...base, type: "boolean", options: [] });
    else if (inner === "enum") fields.push({ ...base, type: "enum", options: Object.values(t.def?.entries ?? {}) });
    else fields.push({ ...base, type: "json", options: [] });
  }
  return fields;
}

/** Coerce the strings a form posts back into the values the schema
 *  expects, per field descriptor; the schema itself validates after. */
export function coerceConfigValues(
  fields: ConfigField[],
  raw: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = raw[f.key];
    if (v === undefined || v === "") {
      if (f.type === "boolean") out[f.key] = false;
      else if (f.nullable) out[f.key] = null;
      continue;
    }
    switch (f.type) {
      case "number":
        out[f.key] = Number(v);
        break;
      case "boolean":
        out[f.key] = v === "true" || v === "on" || v === "1";
        break;
      case "json":
        try {
          out[f.key] = JSON.parse(v);
        } catch {
          out[f.key] = v;
        }
        break;
      default:
        out[f.key] = v;
    }
  }
  return out;
}
