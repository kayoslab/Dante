"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runSync } from "@/lib/sync/run";
import { audit } from "@/lib/auth/audit";
import { ForbiddenError, requireSession } from "@/lib/auth/session";

import {
  err,
  fromZod,
  ok,
  type ActionResult,
} from "./_action-helpers";

const RunSyncSchema = z.object({
  source: z.enum(["all", "personio", "awork"]),
});

export type RunSyncSuccess = {
  source: "all" | "personio" | "awork";
  duration_ms: number;
  log: string;
};

export async function runSyncAction(
  input: unknown,
): Promise<ActionResult<RunSyncSuccess>> {
  let ctx;
  try {
    ctx = await requireSession({ minRole: "admin" });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return err("forbidden", "Only admins can trigger a sync.");
    }
    throw e;
  }
  const parsed = RunSyncSchema.safeParse(input);
  if (!parsed.success) return fromZod(parsed.error);

  await audit(ctx, {
    action: "sync_triggered",
    target_type: "sync",
    target_id: parsed.data.source,
  });

  const lines: string[] = [];
  const started = Date.now();
  try {
    await runSync({ source: parsed.data.source }, (line) => lines.push(line));
  } catch (e) {
    return err(
      "internal_error",
      `${e instanceof Error ? e.message : String(e)}\n\n${lines.join("\n")}`,
    );
  }
  const duration_ms = Date.now() - started;

  // Sync wrote to many tables; tell Next.js to drop its cached server renders
  // so dashboards reflect fresh data on next navigation.
  revalidatePath("/", "layout");

  return ok({
    source: parsed.data.source,
    duration_ms,
    log: lines.join("\n"),
  });
}
