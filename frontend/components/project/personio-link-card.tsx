"use client";

import { useMemo, useState } from "react";
import { CornerDownRight, Link2, Plus, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  useCreatePersonioLink,
  useDeletePersonioLink,
  usePersonioLinksFor,
  usePersonioProjects,
  type PersonioProjectItem,
} from "@/lib/api/personio-projects";

/** Flatten the Personio projects into depth-annotated rows so parent →
 * subproject nesting renders as an indented tree. A child whose parent
 * isn't in the current (searched/filtered) result set is surfaced at the
 * root as an "orphan" — still findable, with a breadcrumb to its parent. */
type PersonioTreeRow = {
  item: PersonioProjectItem;
  depth: number;
  orphan: boolean;
};

function flattenPersonioTree(
  items: PersonioProjectItem[],
): PersonioTreeRow[] {
  const byId = new Map(items.map((i) => [i.personio_project_id, i]));
  const childrenOf = new Map<string, PersonioProjectItem[]>();
  const roots: { item: PersonioProjectItem; orphan: boolean }[] = [];
  for (const it of items) {
    const pid = it.parent_id ?? null;
    if (pid && byId.has(pid)) {
      const arr = childrenOf.get(pid) ?? [];
      arr.push(it);
      childrenOf.set(pid, arr);
    } else {
      // Top-level (no parent) or orphan (parent filtered out of this view).
      roots.push({ item: it, orphan: Boolean(pid) });
    }
  }
  const out: PersonioTreeRow[] = [];
  const visit = (item: PersonioProjectItem, depth: number, orphan: boolean) => {
    out.push({ item, depth, orphan });
    for (const child of childrenOf.get(item.personio_project_id) ?? []) {
      visit(child, depth + 1, false);
    }
  };
  for (const r of roots) visit(r.item, 0, r.orphan);
  return out;
}

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
  // Off by default: hide archived (and vanished-from-Personio) projects so
  // the list isn't cluttered with dead entries. Flip on to re-link one.
  const [showArchived, setShowArchived] = useState(false);
  const create = useCreatePersonioLink(projectId);
  // Show only currently-unmapped projects so the user can't double-link.
  // Server groups each parent → subproject subtree together and resolves the
  // parent name; the tree is rebuilt client-side for indented rendering.
  const list = usePersonioProjects({
    mapped: false,
    q: q.length >= 2 ? q : undefined,
    show_archived: showArchived,
  });
  const rows = useMemo(
    () => flattenPersonioTree(list.data ?? []),
    [list.data],
  );

  async function link(personioId: string) {
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
            was renamed or split mid-engagement. Subprojects are shown
            indented under their parent.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search name (e.g. Acme, Globex)…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-sm text-muted-foreground">
            Show archived projects
          </span>
          <Switch
            checked={showArchived}
            onCheckedChange={(next) => setShowArchived(next)}
          />
        </div>
        <div className="overflow-y-auto rounded-md border max-h-[55vh]">
          {list.isLoading && (
            <div className="space-y-1.5 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {list.data && rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              No unmapped Personio projects match.
            </p>
          )}
          {rows.length > 0 && (
            <ul className="divide-y text-sm">
              {rows.slice(0, 200).map((row) => (
                <PersonioPickRow
                  key={row.item.personio_project_id}
                  row={row}
                  onLink={link}
                  disabled={create.isPending}
                />
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PersonioPickRow({
  row,
  onLink,
  disabled,
}: {
  row: PersonioTreeRow;
  onLink: (personioId: string) => void;
  disabled: boolean;
}) {
  const { item, depth, orphan } = row;
  return (
    <li
      className="flex items-center justify-between gap-3 py-2 pr-3 hover:bg-muted/40"
      // Indent nested subprojects; base padding 12px + 20px per level.
      style={{ paddingLeft: 12 + depth * 20 }}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {depth > 0 && (
            <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="font-medium truncate">{item.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            #{item.personio_project_id}
          </span>
          {item.active === false && <Badge variant="outline">archived</Badge>}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {orphan && item.parent_name && (
            <span className="mr-2">sub-project of {item.parent_name} · </span>
          )}
          {item.n_attendance_entries.toLocaleString()} entries
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onLink(item.personio_project_id)}
        disabled={disabled}
      >
        Link
      </Button>
    </li>
  );
}
