import { requireSession } from "@/lib/auth/session";

import { CalendarClient } from "./calendar-client";

export const metadata = { title: "Calendar — Dante" };

export default async function CalendarPage() {
  // Employees are allowed — the calendar shows allocations + project names
  // only, no rates / margins / cost. Confirmed by Day-4 audit.
  await requireSession();
  return <CalendarClient />;
}
