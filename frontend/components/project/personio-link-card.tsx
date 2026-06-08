"use client";

import { useState } from "react";
import { Link2, Plus, Trash2, X } from "lucide-react";
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
  useCreatePersonioLink,
  useDeletePersonioLink,
  usePersonioLinksFor,
  usePersonioProjects,
} from "@/lib/api/personio-projects";

export function PersonioLinkCard({ projectId }: { projectId: number }) {
  const linksQ = usePersonioLinksFor(projectId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          Personio project link ({linksQ.data?.length ?? 0})
        </CardTitle>
        <AddLinkDialog projectId={projectId} />
      </CardHeader>
      <CardContent>
        <QueryGuard query={linksQ} skeletonHeight="h-12">
          {(links) =>
            links.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No Personio project linked yet. The monthly breakdown&apos;s
                &quot;Tracked&quot; column will stay empty until you map at
                least one Personio project here.
              </p>
            ) : (
              <ul className="space-y-2">
                {links.map((p) => (
                  <LinkRow
                    key={p.personio_project_id}
                    item={p}
                    projectId={projectId}
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

function LinkRow({
  item,
  projectId,
}: {
  item: import("@/lib/api/personio-projects").PersonioProjectItem;
  projectId: number;
}) {
  const del = useDeletePersonioLink(projectId);

  async function unlink() {
    try {
      await del.mutateAsync(item.personio_project_id);
      toast.success(`Unlinked "${item.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{item.name}</span>
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            #{item.personio_project_id}
          </span>
          {item.active === false && (
            <Badge variant="outline" className="text-muted-foreground">
              archived
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {item.n_attendance_entries.toLocaleString()} attendance entries logged
          here
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

function AddLinkDialog({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const create = useCreatePersonioLink(projectId);
  // Show only currently-unmapped projects so the user can't double-link.
  // Server sorts by attendance entry count desc, so the most-used internal
  // projects (6443 Interne Tätigkeit etc.) bubble to the top — usually
  // exactly what the user wants to skip / find by name search.
  const list = usePersonioProjects({ mapped: false, q: q.length >= 2 ? q : undefined });

  async function link(personioId: number) {
    try {
      await create.mutateAsync(personioId);
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
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            Link Personio project
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Link a Personio project</DialogTitle>
          <DialogDescription>
            Pick the Personio project (or projects) consultants tagged when
            logging time for this customer engagement. Multiple Personio
            projects can map to one of ours — useful when a customer name
            was renamed or split mid-engagement.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search name (e.g. Globex, Initech)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="overflow-y-auto rounded-md border max-h-[55vh]">
          {list.isLoading && (
            <div className="space-y-1.5 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {list.data && list.data.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No unmapped Personio projects match.
            </p>
          )}
          {list.data && list.data.length > 0 && (
            <ul className="divide-y text-sm">
              {list.data.slice(0, 200).map((p) => (
                <li
                  key={p.personio_project_id}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium truncate">{p.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        #{p.personio_project_id}
                      </span>
                      {p.active === false && (
                        <Badge variant="outline">archived</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {p.n_attendance_entries.toLocaleString()} entries
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => link(p.personio_project_id)}
                    disabled={create.isPending}
                  >
                    Link
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            <X className="mr-1.5 h-4 w-4" />
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
