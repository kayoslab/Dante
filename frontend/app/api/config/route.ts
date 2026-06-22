import { listSettings } from "@/lib/db/queries/setting";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "admin" });
    const rows = await listSettings();
    return rows.map((r) => ({
      key: r.key,
      value: r.value,
      description: r.description,
      updated_at: r.updated_at ? r.updated_at.toISOString() : null,
    }));
  });
}
