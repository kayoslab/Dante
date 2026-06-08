import { Card, CardContent } from "@/components/ui/card";

export type AuditRow = {
  audit_id: number;
  action: string;
  target_type: string;
  target_id: string | null;
  occurred_at: string;
  ip_address: string | null;
  actor_email: string | null;
  actor_role: string | null;
};

/** Server Component — pure render. No client state needed; pagination
 * cursor is in the URL. */
export function AuditTable({ rows }: { rows: AuditRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No audit entries yet.
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-medium">When</th>
                <th className="px-3 py-2 text-left font-medium">Who</th>
                <th className="px-3 py-2 text-left font-medium">Action</th>
                <th className="px-3 py-2 text-left font-medium">Target</th>
                <th className="px-3 py-2 text-left font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.audit_id}>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {new Date(r.occurred_at).toLocaleString("de-DE")}
                  </td>
                  <td className="px-3 py-2">
                    {r.actor_email ?? (
                      <span className="text-muted-foreground italic">
                        deleted user
                      </span>
                    )}
                    {r.actor_role && (
                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                        {r.actor_role}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.action}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {r.target_type}
                    {r.target_id ? ` · ${r.target_id}` : ""}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">
                    {r.ip_address ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
