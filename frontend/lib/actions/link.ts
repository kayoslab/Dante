"use server";

import { z } from "zod";

import { getSettingDescription, upsertSetting } from "@/lib/db/queries/setting";

import { err, fromZod, ok, requireActionRole, type ActionResult } from "./_action-helpers";

// ----------------------------------------------------------------------------
// setting upsert
// ----------------------------------------------------------------------------

export type SettingItem = {
  key: string;
  value: string;
  description: string | null;
  updated_at: string | null;
};

const SettingUpdateSchema = z.object({
  value: z.string(),
  description: z.string().nullable().optional(),
});

export async function putSettingAction(
  key: string,
  input: unknown,
): Promise<ActionResult<SettingItem>> {
  const auth = await requireActionRole("admin");
  if (!auth.ok) return auth.result;

  if (!key) return err("validation_error", "key is required");
  const parsed = SettingUpdateSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  // Preserve existing description when not explicitly provided — same
  // behavior as the Python service so an FE that only sends `value` keeps
  // the explanatory text intact.
  let description: string | null = parsed.data.description ?? null;
  if (parsed.data.description === undefined || parsed.data.description === null) {
    description = await getSettingDescription(key);
  }

  const row = await upsertSetting({
    key,
    value: parsed.data.value,
    description,
    updated_at: new Date(),
  });
  if (!row) return err("internal_error", "setting upsert vanished");
  return ok({
    key: row.key,
    value: row.value,
    description: row.description,
    updated_at: row.updated_at.toISOString(),
  });
}
