import { forbidden } from "next/navigation";

import { listAppUsers } from "@/lib/db/queries/app-user";
import { hasRole, requireSession } from "@/lib/auth/session";

import { UsersClient } from "./users-client";

export const metadata = { title: "Users — Dante" };

export default async function UsersPage() {
  const ctx = await requireSession();
  if (!hasRole(ctx, "admin")) forbidden();

  const rows = await listAppUsers();

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
      }))}
    />
  );
}
