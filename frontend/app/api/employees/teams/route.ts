import { listEmployeeTeams } from "@/lib/db/queries/employee-list";
import { handle, requireApiSession } from "@/lib/api/_route-helpers";

// Distinct curated team names used to populate the employee-filter dropdown.
// strings (no objects).
export async function GET() {
  return handle(async () => {
    await requireApiSession();
    return listEmployeeTeams();
  });
}
