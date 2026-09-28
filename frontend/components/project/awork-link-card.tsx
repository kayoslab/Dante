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
  useAworkProjectLinksFor,
  useAworkProjects,
  useCreateAworkProjectLink,
  useDeleteAworkProjectLink,
} from "@/lib/api/awork";

export function AworkLinkCard({ projectId }: { projectId: number }) {
  const linksQ = useAworkProjectLinksFor(projectId);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Link2 className="h-4 w-4" />
          awork project link ({linksQ.data?.length ?? 0})
        </CardTitle>
        <AddAworkLinkDialog projectId={projectId} />
      </CardHeader>
      <CardContent>
        <QueryGuard query={linksQ} skeletonHeight="h-12">
          {(links) =>
            links.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No awork project linked yet. Used by the Security Testing team
                and anyone else logging time in awork rather than Personio.
              </p>
            ) : (
              <ul className="space-y-2">
                {links.map((p) => (
                  <LinkRow
                    key={p.awork_project_id}
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
  item: import("@/lib/api/awork").AworkProjectItem;
  projectId: number;
}) {
  const del = useDeleteAworkProjectLink(projectId);

  async function unlink() {
    try {
      await del.mutateAsync(item.awork_project_id);
      toast.success(`Unlinked "${item.name ?? item.awork_project_id}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {item.awork_company_name && (
            <span className="text-muted-foreground truncate">
              {item.awork_company_name} /
            </span>
          )}
          <span className="font-medium truncate">{item.name}</span>
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {item.n_time_entries.toLocaleString()} time entries
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

function AddAworkLinkDialog({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const create = useCreateAworkProjectLink(projectId);
  const list = useAworkProjects({
    mapped: false,
    q: q.length >= 2 ? q : undefined,
  });

  async function link(awork_project_id: string) {
    try {
      await create.mutateAsync(awork_project_id);
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
            Link awork project
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Link an awork project</DialogTitle>
          <DialogDescription>
            Pick the awork project that corresponds to this customer
            engagement. awork projects are listed with their company name
            (the awork equivalent of customer), sorted by time-entry volume.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search name (e.g. Acme, Globex)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="max-h-[55vh] overflow-y-auto rounded-md border">
          {list.isLoading && (
            <div className="space-y-1.5 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {list.data && list.data.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No unmapped awork projects match.
            </p>
          )}
          {list.data && list.data.length > 0 && (
            <ul className="divide-y text-sm">
              {list.data.slice(0, 200).map((p) => (
                <li
                  key={p.awork_project_id}
                  className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {p.awork_company_name && (
                        <span className="text-muted-foreground truncate">
                          {p.awork_company_name} /
                        </span>
                      )}
                      <span className="font-medium truncate">{p.name}</span>
                      {p.is_external && (
                        <Badge variant="outline">external</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {p.n_time_entries.toLocaleString()} entries
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => link(p.awork_project_id)}
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
