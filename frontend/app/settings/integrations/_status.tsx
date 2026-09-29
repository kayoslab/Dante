import { Badge } from "@/components/ui/badge";
import type { CredentialState } from "@/lib/db/schema/integration";

const LABEL: Record<CredentialState, { text: string; variant: "secondary" | "destructive" | "outline" }> = {
  missing: { text: "No credentials", variant: "destructive" },
  set: { text: "Credentials set", variant: "secondary" },
  invalid: { text: "Credentials rejected", variant: "destructive" },
  external: { text: "Credentials managed outside Dante", variant: "outline" },
};

export function CredentialStateBadge({ state }: { state: CredentialState }) {
  const l = LABEL[state] ?? LABEL.missing;
  return <Badge variant={l.variant}>{l.text}</Badge>;
}

export function formatWhen(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
}
