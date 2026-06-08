"use client";

import { useState } from "react";
import { Link2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { QueryGuard } from "@/components/ui/query-guard";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useAworkUserLinksFor,
  useAworkUsers,
  useCreateAworkUserLink,
  useDeleteAworkUserLink,
} from "@/lib/api/awork";

export function EmployeeAworkLinkCard({ employeeId }: { employeeId: number }) {
  const linksQ = useAworkUserLinksFor(employeeId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          awork user link ({linksQ.data?.length ?? 0})
        </CardTitle>
        <AddAworkUserDialog employeeId={employeeId} />
      </CardHeader>
      <CardContent>
        <QueryGuard query={linksQ} skeletonHeight="h-10">
          {(links) =>
            links.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No awork user mapped. Auto-mapping by email happens during sync
                — this is for fixing email mismatches.
              </p>
            ) : (
              <ul className="space-y-2">
                {links.map((u) => (
                  <UserLinkRow
                    key={u.awork_user_id}
                    item={u}
                    employeeId={employeeId}
                  />
                ))}
              </ul>
            )
          }
        </QueryGuard>
      </CardContent>
    </Card>
  );
}

function UserLinkRow({
  item,
  employeeId,
}: {
  item: import("@/lib/api/awork").AworkUserItem;
  employeeId: number;
}) {
  const del = useDeleteAworkUserLink(employeeId);
  async function unlink() {
    try {
      await del.mutateAsync(item.awork_user_id);
      toast.success("Unlinked");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="font-medium truncate">
          {item.first_name} {item.last_name}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {item.email ?? "(no email)"} · {item.n_time_entries.toLocaleString()} entries
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={unlink}
        disabled={del.isPending}
        title="Unlink"
      >
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

function AddAworkUserDialog({ employeeId }: { employeeId: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const create = useCreateAworkUserLink(employeeId);
  // Show unlinked, non-archived users sorted by activity (server side).
  const list = useAworkUsers({ linked: false });

  const filtered =
    q.length >= 2
      ? (list.data ?? []).filter((u) => {
          const hay = `${u.first_name} ${u.last_name} ${u.email}`.toLowerCase();
          return hay.includes(q.toLowerCase());
        })
      : list.data ?? [];

  async function link(awork_user_id: string) {
    try {
      await create.mutateAsync(awork_user_id);
      toast.success("Linked");
      setOpen(false);
      setQ("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQ("");
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Plus className="mr-2 h-4 w-4" />
            Link awork user
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Link an awork user</DialogTitle>
          <DialogDescription>
            Use this when the email match didn&apos;t catch (different domain
            between awork and Personio). Most unmapped users are external
            partner-org collaborators (trovent, fzi, xivotec, alter-solutions
            etc.) and don&apos;t need linking — only link people who are
            actually this employee.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search name or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="max-h-[55vh] overflow-y-auto rounded-md border">
          {list.isLoading && (
            <div className="space-y-1.5 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {filtered.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No unlinked awork users match.
            </p>
          )}
          {filtered.length > 0 && (
            <ul className="divide-y text-sm">
              {filtered.slice(0, 200).map((u) => (
                <li
                  key={u.awork_user_id}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">
                        {u.first_name} {u.last_name}
                      </span>
                      {u.is_external && (
                        <Badge variant="outline">external</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">
                      {u.email ?? "(no email)"} ·{" "}
                      {u.n_time_entries.toLocaleString()} entries
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => link(u.awork_user_id)}
                    disabled={create.isPending}
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
