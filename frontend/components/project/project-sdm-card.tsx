"use client";

import { useState } from "react";
import { Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGrantProjectSdm,
  useGrantableUsers,
  useProjectSdms,
  useRevokeProjectSdm,
} from "@/lib/api/projects";

/** Admin-only sub-card on the project detail page.
 *
 * Lists current SDMs and provides a picker to grant a new one. Hidden
 * for non-admin viewers (the parent already gates this; the `viewer_role`
 * prop is the second line of defence so the card never renders for
 * anyone outside the admin role).
 *
 * Note: granting/revoking does not change the target user's app role —
 * an SDM is still an `employee` in the role ladder. The capability is
 * scoped to the project_ids listed in `project_sdm`. */
export function ProjectSdmCard({
  projectId,
  viewerRole,
}: {
  projectId: number;
  viewerRole: "admin" | "manager" | "employee";
}) {
  const isAdmin = viewerRole === "admin";
  const sdms = useProjectSdms(projectId, isAdmin);
  const grantable = useGrantableUsers(projectId, isAdmin);
  const grant = useGrantProjectSdm(projectId);
  const revoke = useRevokeProjectSdm(projectId);
  const [pickedUserId, setPickedUserId] = useState<string>("");

  if (!isAdmin) return null;

  const onGrant = async () => {
    if (!pickedUserId) return;
    try {
      await grant.mutateAsync(pickedUserId);
      toast.success("SDM granted");
      setPickedUserId("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to grant");
    }
  };

  const onRevoke = async (user_id: string, label: string) => {
    try {
      await revoke.mutateAsync(user_id);
      toast.success(`Revoked ${label}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Service Delivery Managers</CardTitle>
        <p className="text-xs text-muted-foreground">
          Employees granted access to manage this project as if they were a
          manager. Admin/manager users have implicit access and don't need a
          grant.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {sdms.isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : sdms.data && sdms.data.length > 0 ? (
          <ul className="divide-y rounded border">
            {sdms.data.map((s) => {
              const name =
                s.first_name || s.last_name
                  ? `${s.first_name ?? ""} ${s.last_name ?? ""}`.trim()
                  : s.email;
              return (
                <li
                  key={s.user_id}
                  className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {s.email}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onRevoke(s.user_id, name)}
                    disabled={revoke.isPending}
                    aria-label={`Revoke ${name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No SDMs granted on this project.
          </p>
        )}

        <div className="flex items-center gap-2">
          <select
            className="flex-1 rounded-md border bg-background px-2 py-1.5 text-sm"
            value={pickedUserId}
            onChange={(e) => setPickedUserId(e.target.value)}
            disabled={grant.isPending || !grantable.data}
          >
            <option value="">— add employee —</option>
            {(grantable.data ?? []).map((u) => {
              const label =
                u.first_name || u.last_name
                  ? `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim()
                  : u.email;
              return (
                <option key={u.user_id} value={u.user_id}>
                  {label}
                </option>
              );
            })}
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={onGrant}
            disabled={!pickedUserId || grant.isPending}
          >
            <UserPlus className="mr-2 h-4 w-4" />
            Grant
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
