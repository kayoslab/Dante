import { handle, requireApiSession } from "@/lib/api/_route-helpers";
import { buildSettingsList } from "@/lib/reports/settings";

export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "admin" });
    // Row mapping lives in lib/reports/settings.ts so the server-side
    // prefetch in app/settings/page.tsx ships the same wire shape.
    return buildSettingsList();
  });
}
