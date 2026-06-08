import { asc } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "admin" });
    const rows = await db
      .select({
        key: setting.key,
        value: setting.value,
        description: setting.description,
        updated_at: setting.updated_at,
      })
      .from(setting)
      .orderBy(asc(setting.key));
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      description: r.description,
      updated_at: r.updated_at ? r.updated_at.toISOString() : null,
    }));
  });
}
