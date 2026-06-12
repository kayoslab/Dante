import { desc, eq, sql } from "drizzle-orm";
import { forbidden } from "next/navigation";

import { db } from "@/lib/db/client";
import { appUser, employeeCurrent } from "@/lib/db/schema";
import { hasRole, requireSession } from "@/lib/auth/session";

import { UsersClient } from "./users-client";

export const metadata = { title: "Users — Dante" };

export default async function UsersPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();

  const rows = await db
    .select({
      user_id: appUser.user_id,
      email: appUser.email,
      role: appUser.role,
      is_disabled: appUser.is_disabled,
      employee_id: appUser.employee_id,
      employee_first_name: employeeCurrent.first_name,
      employee_last_name: employeeCurrent.last_name,
      created_at: appUser.created_at,
      last_login_at: appUser.last_login_at,
      mfa_required: appUser.mfa_required,
      mfa_enrolled: sql<boolean>`${appUser.mfa_enrolled_at} IS NOT NULL`,
    })
    .from(appUser)
    .leftJoin(employeeCurrent, eq(employeeCurrent.employee_id, appUser.employee_id))
    .orderBy(desc(appUser.created_at));

  return (
    <UsersClient
      currentUserId={ctx.user_id}
      users={rows.map((r) => ({
        user_id: r.user_id,
        email: r.email,
        role: r.role,
        is_disabled: r.is_disabled,
        employee_id: r.employee_id,
        employee_name:
          r.employee_first_name && r.employee_last_name
            ? `${r.employee_first_name} ${r.employee_last_name}`
            : null,
        created_at: r.created_at.toISOString(),
        last_login_at: r.last_login_at?.toISOString() ?? null,
        mfa_required: r.mfa_required,
        mfa_enrolled: r.mfa_enrolled,
      }))}
    />
  );
}
