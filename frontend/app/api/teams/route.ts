import { listTeams } from "@/lib/db/queries/team";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

export async function GET() {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    return await listTeams();
  });
}
