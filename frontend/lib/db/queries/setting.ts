import { eq, sql } from "drizzle-orm";

import { db } from "../client";
import { setting } from "../schema";

export type SettingRow = {
  key: string;
  value: string;
  description: string | null;
  updated_at: Date;
};

/** Look up the description on an existing setting row — used when the
 * caller does NOT pass a description in the upsert payload so we can
 * preserve the existing one rather than blanking it. Returns `null`
 * when the key does not yet exist. */
export async function getSettingDescription(
  key: string,
): Promise<string | null> {
  const [row] = await db
    .select({ description: setting.description })
    .from(setting)
    .where(eq(setting.key, key));
  return row?.description ?? null;
}

/** Upsert a setting row. The description handling matches the Python
 * service: callers that pass `description = null` AFTER resolving the
 * "preserve existing" rule get that exact value written. The caller
 * owns the resolution so the query stays a single statement. */
export async function upsertSetting(input: {
  key: string;
  value: string;
  description: string | null;
  updated_at: Date;
}): Promise<SettingRow | null> {
  await db.execute(sql`
    INSERT INTO setting (key, value, description, updated_at)
    VALUES (${input.key}, ${input.value}, ${input.description}, ${input.updated_at})
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at
  `);

  const [row] = await db
    .select({
      key: setting.key,
      value: setting.value,
      description: setting.description,
      updated_at: setting.updated_at,
    })
    .from(setting)
    .where(eq(setting.key, input.key));
  return row ?? null;
}
