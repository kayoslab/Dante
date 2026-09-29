import type { NextRequest } from "next/server";

import { handle, requireApiSession, Validation } from "@/lib/api/_route-helpers";
import { audit } from "@/lib/auth/audit";
import { requireApiProjectAccess } from "@/lib/auth/project-capability";
import { listLinksFor } from "@/lib/db/queries/external-records";
import { DANTE_ENTITY_TYPES, type DanteEntityType } from "@/lib/integrations/core/capabilities";

/** Every external record linked to one Dante entity, across integrations.
 * `?dante_type=project&dante_id=123`. Project links follow project access
 * (SDMs see their own projects); the rest need manager. */
export async function GET(req: NextRequest) {
  return handle(async () => {
    const { searchParams } = new URL(req.url);
    const dante_type = searchParams.get("dante_type") ?? "";
    const dante_id = Number(searchParams.get("dante_id"));
    if (!(DANTE_ENTITY_TYPES as readonly string[]).includes(dante_type)) {
      throw Validation(`dante_type must be one of ${DANTE_ENTITY_TYPES.join(", ")}`);
    }
    if (!Number.isInteger(dante_id)) throw Validation("dante_id must be an integer");

    if (dante_type === "project") {
      await requireApiProjectAccess(dante_id);
    } else {
      const ctx = await requireApiSession({ minRole: "manager" });
      if (dante_type === "employee") {
        await audit(ctx, { action: "view_employee_links", target_type: "employee", target_id: dante_id });
      }
    }
    return listLinksFor({ dante_type: dante_type as DanteEntityType, dante_id });
  });
}
