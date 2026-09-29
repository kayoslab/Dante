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
  useCreateLink,
  useDeleteLink,
  useExternalRecords,
  useLinksFor,
  type ExternalRecordItem,
  type LinkItem,
} from "@/lib/api/integrations";
import type { LinkInput } from "@/lib/actions/external-links";

type EntityType = LinkInput["entity_type"];
type DanteType = LinkInput["dante_type"];

const ENTITY_LABEL: Record<EntityType, { one: string; many: string; entries: string }> = {
  person: { one: "user", many: "users", entries: "time entries" },
  project: { one: "project", many: "projects", entries: "time entries" },
  company: { one: "company", many: "companies", entries: "projects" },
};

/** Links between one integration's records and one Dante entity: the
 * linked records with unlink, and a picker over the unlinked ones.
 * Provider-agnostic — the integration's display name, the record type and
 * the Dante side come in as props. */
export function ExternalLinkCard({
  integration,
  entityType,
  danteType,
  danteId,
  hint,
}: {
  integration: { slug: string; display_name: string };
  entityType: EntityType;
  danteType: DanteType;
  danteId: number;
  hint?: string;
}) {
  const linksQ = useLinksFor(danteType, danteId);
  const label = ENTITY_LABEL[entityType];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-4 w-4" />
          {integration.display_name} {label.one} link (
          {linksQ.data?.filter((l) => l.integration_slug === integration.slug).length ?? 0})
        </CardTitle>
        <AddLinkDialog
          integration={integration}
          entityType={entityType}
          danteType={danteType}
          danteId={danteId}
        />
      </CardHeader>
      <CardContent>
        <QueryGuard query={linksQ} skeletonHeight="h-12">
          {(links) => {
            const mine = links.filter((l) => l.integration_slug === integration.slug);
            return mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {hint ?? `No ${integration.display_name} ${label.one} linked yet.`}
              </p>
            ) : (
              <ul className="space-y-2">
                {mine.map((l) => (
                  <LinkRow key={l.external_id} item={l} danteType={danteType} danteId={danteId} />
                ))}
              </ul>
            );
          }}
        </QueryGuard>
      </CardContent>
    </Card>
  );
}

function LinkRow({ item, danteType, danteId }: { item: LinkItem; danteType: DanteType; danteId: number }) {
  const del = useDeleteLink();
  const label = ENTITY_LABEL[item.entity_type];
  async function unlink() {
    try {
      await del.mutateAsync({
        integration_slug: item.integration_slug,
        entity_type: item.entity_type,
        external_id: item.external_id,
        dante_type: danteType,
        dante_id: danteId,
      });
      toast.success(`Unlinked "${item.name ?? item.external_id}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }
  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {item.entity_type === "project" && item.secondary && (
            <span className="truncate text-muted-foreground">{item.secondary} /</span>
          )}
          <span className="truncate font-medium">{item.name ?? item.external_id}</span>
          {item.entity_type !== "person" && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">#{item.external_id}</span>
          )}
          {item.active === false && (
            <Badge variant="outline" className="text-muted-foreground">
              archived
            </Badge>
          )}
        </div>
        <div className="truncate text-xs tabular-nums text-muted-foreground">
          {item.entity_type === "person" && `${item.secondary ?? "(no email)"} · `}
          {item.n_entries.toLocaleString()} {label.entries}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={unlink} disabled={del.isPending} title="Unlink">
        <Trash2 className="h-4 w-4" />
      </Button>
    </li>
  );
}

type TreeRow = { item: ExternalRecordItem; depth: number; orphan: boolean };

/** Parent → child nesting for record types that carry a parent (Personio
 * sub-projects). A child whose parent is not in the result set surfaces at
 * the root as an "orphan", still findable, with a breadcrumb. */
function flattenTree(items: ExternalRecordItem[]): TreeRow[] {
  const byId = new Map(items.map((i) => [i.external_id, i]));
  const childrenOf = new Map<string, ExternalRecordItem[]>();
  const roots: { item: ExternalRecordItem; orphan: boolean }[] = [];
  for (const it of items) {
    const pid = it.parent_external_id ?? null;
    if (pid && byId.has(pid)) {
      const arr = childrenOf.get(pid) ?? [];
      arr.push(it);
      childrenOf.set(pid, arr);
    } else {
      roots.push({ item: it, orphan: Boolean(pid) });
    }
  }
  const out: TreeRow[] = [];
  const visit = (item: ExternalRecordItem, depth: number, orphan: boolean) => {
    out.push({ item, depth, orphan });
    for (const child of childrenOf.get(item.external_id) ?? []) visit(child, depth + 1, false);
  };
  for (const r of roots) visit(r.item, 0, r.orphan);
  return out;
}

function AddLinkDialog({
  integration,
  entityType,
  danteType,
  danteId,
}: {
  integration: { slug: string; display_name: string };
  entityType: EntityType;
  danteType: DanteType;
  danteId: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const create = useCreateLink();
  const label = ENTITY_LABEL[entityType];
  // Only unmapped records, so the user can't double-link. The server does
  // the name / company / parent search; persons are filtered client-side
  // too because their list is small and the search wants e-mail.
  const list = useExternalRecords(
    integration.slug,
    { type: entityType, mapped: false, q: q.length >= 2 ? q : undefined, include_archived: showArchived },
    open,
  );
  const rows = useMemo(() => flattenTree(list.data ?? []), [list.data]);

  async function link(external_id: string) {
    try {
      await create.mutateAsync({
        integration_slug: integration.slug,
        entity_type: entityType,
        external_id,
        dante_type: danteType,
        dante_id: danteId,
      });
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
            Link {integration.display_name} {label.one}
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] max-w-2xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            Link a {integration.display_name} {label.one}
          </DialogTitle>
          <DialogDescription>
            {entityType === "project" &&
              "Pick the source project(s) that correspond to this engagement. Several source projects can map to one Dante project — sub-projects are shown indented under their parent."}
            {entityType === "person" &&
              "Use this when the e-mail match did not catch (different domain between the tools). Only link people who actually are this person."}
            {entityType === "company" && "Pick the source company that corresponds to this customer."}
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder={entityType === "person" ? "Search name or e-mail…" : "Search name…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <div className="flex items-center justify-between gap-2 px-0.5">
          <span className="text-sm text-muted-foreground">Show archived {label.many}</span>
          <Switch checked={showArchived} onCheckedChange={(next) => setShowArchived(next)} />
        </div>
        <div className="max-h-[55vh] overflow-y-auto rounded-md border">
          {list.isLoading && (
            <div className="space-y-1.5 p-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {list.data && rows.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No unmapped {label.many} match.</p>
          )}
          {rows.length > 0 && (
            <ul className="divide-y text-sm">
              {rows.slice(0, 200).map(({ item, depth, orphan }) => (
                <li
                  key={item.external_id}
                  className="flex items-center justify-between gap-3 py-2 pr-3 hover:bg-muted/40"
                  style={{ paddingLeft: 12 + depth * 20 }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      {depth > 0 && <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      {item.entity_type === "project" && item.secondary && (
                        <span className="truncate text-muted-foreground">{item.secondary} /</span>
                      )}
                      <span className="truncate font-medium">{item.name ?? item.external_id}</span>
                      {item.entity_type !== "person" && (
                        <span className="font-mono text-xs text-muted-foreground">#{item.external_id}</span>
                      )}
                      {item.active === false && <Badge variant="outline">archived</Badge>}
                      {item.is_external && <Badge variant="outline">external</Badge>}
                    </div>
                    <div className="truncate text-xs tabular-nums text-muted-foreground">
                      {orphan && item.parent_name && <span className="mr-2">sub-project of {item.parent_name} ·</span>}
                      {item.entity_type === "person" && `${item.secondary ?? "(no email)"} · `}
                      {item.n_entries.toLocaleString()} {label.entries}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => link(item.external_id)} disabled={create.isPending}>
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
