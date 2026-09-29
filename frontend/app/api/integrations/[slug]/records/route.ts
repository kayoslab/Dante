import type { NextRequest } from "next/server";

import { boundedSearchQuery, handle, requireApiSession, Validation } from "@/lib/api/_route-helpers";
import { listExternalRecords, listImportableProjects } from "@/lib/db/queries/external-records";
import { getIntegration } from "@/lib/db/queries/integration";
import { EXTERNAL_ENTITY_TYPES, type ExternalEntityType } from "@/lib/integrations/core/capabilities";

/** One integration's records of one type — the link pickers and import
 * lists. Query params:
 *   type=person|project|company   (required)
 *   mapped=true|false             (default: all)
 *   q=<text>                      (name / company / parent match)
 *   include_archived=true         (default: hide archived)
 *   importable_for_customer=<id>  (projects only: unlinked projects whose
 *                                  company is linked to a customer; 0 = any) */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  return handle(async () => {
    await requireApiSession({ minRole: "manager" });
    const { slug } = await params;
    if (!(await getIntegration(slug))) throw Validation(`unknown integration: ${slug}`);
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type") ?? "";
    if (!(EXTERNAL_ENTITY_TYPES as readonly string[]).includes(type)) {
      throw Validation(`type must be one of ${EXTERNAL_ENTITY_TYPES.join(", ")}`);
    }
    const entity_type = type as ExternalEntityType;
    const importable = searchParams.get("importable_for_customer");
    if (importable !== null) {
      if (entity_type !== "project") throw Validation("importable_for_customer applies to projects only");
      const customer_id = Number(importable);
      return listImportableProjects({ slug, customer_id: customer_id > 0 ? customer_id : null });
    }
    const mappedRaw = searchParams.get("mapped");
    const mapped = mappedRaw === null ? null : mappedRaw.toLowerCase() === "true";
    const q = boundedSearchQuery(searchParams.get("q"));
    const include_archived = searchParams.get("include_archived")?.toLowerCase() === "true";
    return listExternalRecords({ slug, entity_type, mapped, q, include_archived });
  });
}
