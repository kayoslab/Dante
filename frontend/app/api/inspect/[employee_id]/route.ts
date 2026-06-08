import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { audit } from "@/lib/auth/audit";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";

type Json = unknown;
function flattenAttributes(
  full: Record<string, unknown>,
): Record<string, Json> {
  const attrs = full.attributes;
  if (!attrs || typeof attrs !== "object") return {};
  const flat: Record<string, Json> = {};
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    if (
      v !== null &&
      typeof v === "object" &&
      "value" in (v as Record<string, unknown>)
    ) {
      flat[k] = (v as Record<string, unknown>).value;
    } else {
      flat[k] = v;
    }
  }
  return flat;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ employee_id: string }> },
) {
  return handle(async () => {
    const ctx = await requireApiSession({ minRole: "manager" });
    const { employee_id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }
    // Sensitive read: the raw Personio payload includes salary, bank, and
    // address fields. Audit the lookup before the query so the trail is
    // captured even if the query itself fails.
    await audit(ctx, {
      action: "view_inspect_payload",
      target_type: "employee",
      target_id: employee_id,
    });

    const r = await db.execute(sql`
      SELECT s.sync_run_id, sr.started_at, s.payload
      FROM raw_employee_snapshot s
      LEFT JOIN sync_run sr ON sr.sync_run_id = s.sync_run_id
      WHERE s.employee_id = ${employee_id}
      ORDER BY sr.started_at DESC NULLS LAST
      LIMIT 1
    `);
    const row = (r.rows as Array<Record<string, unknown>>)[0];
    if (!row) {
      const e = await db.execute(sql`
        SELECT 1 FROM employee_current WHERE employee_id = ${employee_id}
      `);
      if ((e.rows as unknown[]).length === 0) {
        throw NotFound(`employee not found: ${employee_id}`);
      }
      throw NotFound(
        `no raw Personio snapshot for employee ${employee_id} — run \`dante sync\` to capture one`,
      );
    }

    const payload = row.payload;
    let full: Record<string, unknown>;
    if (typeof payload === "string") {
      try {
        full = JSON.parse(payload);
      } catch {
        full = {};
      }
    } else if (payload && typeof payload === "object") {
      full = payload as Record<string, unknown>;
    } else {
      full = {};
    }

    const started_at = row.started_at as Date | string | null;
    const sync_started_at =
      started_at === null
        ? null
        : started_at instanceof Date
          ? started_at.toISOString()
          : String(started_at);

    return {
      employee_id,
      sync_run_id: row.sync_run_id,
      sync_started_at,
      attributes: flattenAttributes(full),
      full_payload: full,
    };
  });
}
