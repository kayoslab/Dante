"use client";

import Link from "next/link";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** A small circular avatar with the user's initials.
 *
 * - Links to /profile so the user can still reach the profile page
 *   after we drop the explicit "Profile" entry from the nav.
 * - Tooltip on hover shows full email + role for the rare moment when
 *   the operator needs to confirm which account they're signed into.
 * - Neutral light-grey background — the avatar is chrome, not content.
 */
function initials(first_name: string | null, last_name: string | null, email: string): string {
  const f = first_name?.trim()?.[0] ?? "";
  const l = last_name?.trim()?.[0] ?? "";
  const combined = `${f}${l}`.toUpperCase();
  if (combined.length > 0) return combined;
  // Fallbacks for unlinked accounts — first char of the local part, then
  // the next non-`@` consonant if available to avoid a lonely "S".
  const localPart = email.split("@")[0] ?? email;
  return (localPart.slice(0, 2) || "?").toUpperCase();
}

export function ProfileAvatar({
  email,
  role,
  first_name,
  last_name,
}: {
  email: string;
  role: "admin" | "manager" | "employee";
  first_name: string | null;
  last_name: string | null;
}) {
  const label = initials(first_name, last_name, email);
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href="/profile"
              aria-label={`Open profile (${email})`}
              className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-[10px] font-medium tracking-wide text-muted-foreground transition hover:bg-muted/80 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-foreground"
            >
              {label}
            </Link>
          }
        />
        <TooltipContent side="bottom" align="end">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">{email}</span>
            <span className="text-[10px] uppercase tracking-wider opacity-80">
              {role}
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
