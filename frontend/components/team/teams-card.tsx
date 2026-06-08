"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QueryGuard } from "@/components/ui/query-guard";
import {
  useTeams,
  useCreateTeam,
  useRenameTeam,
  useDeleteTeam,
  type TeamItem,
} from "@/lib/api/teams";

export function TeamsCard() {
  const teams = useTeams();
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>Teams</CardTitle>
          <p className="text-sm text-muted-foreground">
            Curated team names. People are assigned via their employee
            detail page. New employees default to no team.
          </p>
        </div>
        <CreateTeamDialog />
      </CardHeader>
      <CardContent>
        <QueryGuard query={teams} skeletonHeight="h-32">
          {(rows) =>
            rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No teams yet. Create one to start assigning people.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">Team</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Members
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((t) => (
                      <tr key={t.team_name} className="hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium">{t.team_name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.n_members}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <RenameTeamDialog team={t} />
                            <DeleteTeamDialog team={t} />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </QueryGuard>
      </CardContent>
    </Card>
  );
}

function CreateTeamDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const create = useCreateTeam();

  async function save() {
    try {
      await create.mutateAsync({ name });
      toast.success(`Team "${name}" created`);
      setName("");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName("");
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-2 h-4 w-4" />
            New team
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Create team</DialogTitle>
          <DialogDescription>
            Team name. People are assigned individually from their detail
            page.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-1.5 py-4">
          <Label htmlFor="team-name">Name</Label>
          <Input
            id="team-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="e.g. Security Testing DE"
          />
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameTeamDialog({ team }: { team: TeamItem }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(team.team_name);
  const rename = useRenameTeam();

  async function save() {
    try {
      await rename.mutateAsync({
        team_name: team.team_name,
        new_name: name,
      });
      toast.success(`Renamed to "${name}"`);
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setName(team.team_name);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" title="Rename">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename team</DialogTitle>
          <DialogDescription>
            Cascades the new name to every assigned member ({team.n_members}).
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-1.5 py-4">
          <Label htmlFor="team-rename">Name</Label>
          <Input
            id="team-rename"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={rename.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={
              !name.trim() || name === team.team_name || rename.isPending
            }
          >
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTeamDialog({ team }: { team: TeamItem }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteTeam();
  const hasMembers = team.n_members > 0;

  async function confirm() {
    try {
      await del.mutateAsync({
        team_name: team.team_name,
        force: hasMembers,
      });
      toast.success(
        hasMembers
          ? `"${team.team_name}" deleted (${team.n_members} member(s) unassigned)`
          : `"${team.team_name}" deleted`,
      );
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            title="Delete"
            className="text-red-600 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Delete team &quot;{team.team_name}&quot;?
          </DialogTitle>
          {hasMembers ? (
            <div className="mt-2 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">
                  {team.n_members} {team.n_members === 1 ? "person is" : "people are"}{" "}
                  assigned to this team.
                </div>
                <div>
                  Deleting will unassign them (their team becomes empty).
                  Their employee records are not affected otherwise.
                </div>
              </div>
            </div>
          ) : (
            <DialogDescription>
              No one is assigned to this team. Safe to delete.
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={del.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={del.isPending}
          >
            {del.isPending ? "Deleting…" : hasMembers ? "Delete anyway" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
