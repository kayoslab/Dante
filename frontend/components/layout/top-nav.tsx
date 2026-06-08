import Link from "next/link";

import { SignOutButton } from "./sign-out-button";
import { getSession } from "@/lib/auth/session";
import type { Role } from "@/lib/auth";

type NavLink = {
  href: string;
  label: string;
  minRole?: Role;
};

const LINKS: NavLink[] = [
  { href: "/", label: "Home" },
  { href: "/customers", label: "Customers", minRole: "manager" },
  { href: "/calendar", label: "Calendar" },
  { href: "/employees", label: "Employees" },
  { href: "/freelancers", label: "Freelancers", minRole: "manager" },
  { href: "/salary", label: "Salary", minRole: "manager" },
  { href: "/profile", label: "Profile" },
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
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="hidden sm:inline tabular-nums">
            {session.email}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 uppercase tracking-wider">
            {session.role}
          </span>
          <SignOutButton />
        </div>
      </div>
    </nav>
  );
}
