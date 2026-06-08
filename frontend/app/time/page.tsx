import { requireSession } from "@/lib/auth/session";

import { TimeClient } from "./time-client";

export const metadata = { title: "Time — Dante" };

export default async function TimePage() {
  await requireSession({ minRole: "manager" });
  return <TimeClient />;
}
