import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";

import { db } from "@/lib/db/client";
import { audit } from "@/lib/auth/audit";
import { NotFound, Validation, handle, requireApiSession } from "@/lib/api/_route-helpers";
import { checkRateLimit } from "@/lib/api/rate-limit";

type Json = unknown;

/** Keys we explicitly do NOT return to the FE — bank, tax, government-ID,
 * and any free-text "custom" fields whose contents the operator hasn't
 * vetted. Block-list rather than allow-list because the Personio
 * attribute set drifts with new field types; a new sensitive field
 * defaults to NOT shown until added here AND moved to an allowed bucket.
 *
 * Lowercased, substring-matched against the attribute key (Personio
 * uses snake_case `iban`, `tax_id`, `social_security_number`, etc.). */
const SENSITIVE_ATTR_PATTERNS = [
  "iban",
  "bic",
  "swift",
  "bank",
  "account_number",
  "tax_id",
  "tax_number",
  "social_security",
  "ssn",
  "passport",
  "national_id",
  "id_number",
  "health_insurance",
  "religion",
  "ethnicity",
];

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_ATTR_PATTERNS.some((p) => k.includes(p));
}

function flattenAttributes(
  full: Record<string, unknown>,
): Record<string, Json> {
  const attrs = full.attributes;
  if (!attrs || typeof attrs !== "object") return {};
  const flat: Record<string, Json> = {};
  for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
    // Redact rather than omit — the operator should see that the field
    // exists (helps diagnose missing-data issues) without the value.
    if (isSensitive(k)) {
      flat[k] = "[redacted]";
      continue;
    }
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
    // Rate-limit the per-employee inspect surface. 10/min/user is well
    // above the human review pattern (clicking through 3-4 employees
    // in a row) and well below the script-iterating-IDs pattern that
    // an exfil attempt would generate. Was M-009 in the pre-launch pen
    // test (combined with H-003 audit amplification).
    checkRateLimit(ctx.user_id, "inspect", { per_minute: 10 });
    const { employee_id: rawId } = await params;
    const employee_id = Number(rawId);
    if (!Number.isInteger(employee_id)) {
      throw Validation(`invalid employee id: ${rawId}`);
    }

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

    // Audit only after the query succeeds — pre-query auditing let a
    // manager hammer this endpoint with junk IDs and amplify writes to
    // `app_audit_log` (was H-003 in the pre-launch pen test). Now the
    // table only grows on legitimate reads.
    await audit(ctx, {
      action: "view_inspect_payload",
      target_type: "employee",
      target_id: employee_id,
    });

    // GDPR data minimization: ship only the flattened, redacted attribute
    // map — never the raw Personio payload (was C-004 in the pre-launch
    // pen test). If you need to inspect the raw blob, query
    // `raw_employee_snapshot` directly via psql with a documented purpose.
    return {
      employee_id,
      sync_run_id: row.sync_run_id,
      sync_started_at,
      attributes: flattenAttributes(full),
    };
  });
}
