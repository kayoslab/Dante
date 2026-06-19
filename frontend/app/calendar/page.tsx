import { hasRole, requireSession } from "@/lib/auth/session";

import { CalendarClient } from "./calendar-client";

export const metadata = { title: "Calendar — Dante" };

export default async function CalendarPage() {
  // Employees are allowed to view — the calendar shows allocations + project
  // names only, no rates / margins / cost. Confirmed by Day-4 audit.
  //
  // Allocating from the calendar is manager+. SDMs allocate from the project
  // view (where the route-side `requireProjectAccess` accepts them for the
  // projects they manage). Without `canAllocate`, `CalendarClient` won't
  // wire `onCellClick`, so cells render as plain hoverable tiles with no
  // dialog. The server action behind the dialog still has its own role gate
  // — this is purely a UX layer to not dangle a click affordance the user
  // can't follow through on.
  const ctx = await requireSession();
  const canAllocate = hasRole(ctx, "manager");
  return <CalendarClient canAllocate={canAllocate} />;
}
