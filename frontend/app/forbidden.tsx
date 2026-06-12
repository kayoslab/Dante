import Link from "next/link";
import { LockKeyhole } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

/** Root-level handler for `forbidden()` from `next/navigation`. Rendered
 * with HTTP 403 when a server component calls `forbidden()` (e.g.
 * `/salary`, `/settings/*`, `/projects/[id]` when the SDM check fails).
 *
 * Friendlier than the generic error boundary and not perceived as a
 * crash — the user just lacks the role/grant. */
export default function Forbidden() {
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-6 text-amber-900">
      <div className="flex items-start gap-3">
        <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="flex-1">
          <h2 className="text-base font-semibold">Access denied</h2>
          <p className="mt-1 text-sm">
            You don&rsquo;t have permission to view this page. If you think
            you should, ask your administrator.
          </p>
          <div className="mt-4">
            <Link
              href="/"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
