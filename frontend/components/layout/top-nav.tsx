import Link from "next/link";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { employeeCurrent } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import type { Role } from "@/lib/auth";

import { ProfileAvatar } from "./profile-avatar";
import { SignOutButton } from "./sign-out-button";

type NavLink = {
  href: string;
  label: string;
  minRole?: Role;
};

const LINKS: NavLink[] = [
  { href: "/", label: "Home" },
  { href: "/customers", label: "Customers", minRole: "manager" },
  { href: "/calendar", label: "Calendar" },
  { href: "/teams", label: "Teams", minRole: "manager" },
  { href: "/employees", label: "Employees" },
  { href: "/freelancers", label: "Freelancers", minRole: "manager" },
  { href: "/reports", label: "Reports", minRole: "manager" },
  { href: "/settings", label: "Settings", minRole: "admin" },
];

const ROLE_RANK: Record<Role, number> = {
  employee: 0,
  manager: 1,
  admin: 2,
};

export async function TopNav() {
  const session = await getSession();
  // No nav on the sign-in page — the layout shell is shared, but we hide
  // the chrome until the user is authenticated.
  if (!session) return null;

  // Pull the linked employee's name so the avatar can render proper
  // initials. Unlinked users (no Personio match) fall back to email.
  let first_name: string | null = null;
  let last_name: string | null = null;
  if (session.employee_id !== null) {
    const [row] = await db
      .select({
        first_name: employeeCurrent.first_name,
        last_name: employeeCurrent.last_name,
      })
      .from(employeeCurrent)
      .where(eq(employeeCurrent.employee_id, session.employee_id))
      .limit(1);
    if (row) {
      first_name = row.first_name;
      last_name = row.last_name;
    }
  }

  const visible = LINKS.filter(
    (l) => !l.minRole || ROLE_RANK[session.role] >= ROLE_RANK[l.minRole],
  );

  return (
    <nav className="border-b bg-background">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-8 px-4">
        <Link href="/" className="font-semibold tracking-tight">
          Dante
        </Link>
        <ul className="flex flex-1 items-center gap-4 text-sm text-muted-foreground">
          {visible.map((l) => (
            <li key={l.href}>
              <Link href={l.href} className="hover:text-foreground transition">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-3">
          <ProfileAvatar
            email={session.email}
            role={session.role}
            first_name={first_name}
            last_name={last_name}
          />
          <SignOutButton />
        </div>
      </div>
    </nav>
  );
}
