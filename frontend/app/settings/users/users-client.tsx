"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { KeyIcon, Loader2Icon, MailIcon, Trash2Icon, UserPlusIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteUserAction,
  inviteUserAction,
  resendInvitationAction,
  resetPasswordAction,
  setUserDisabledAction,
  setUserRoleAction,
} from "@/lib/actions/users";

type Role = "admin" | "manager" | "employee";

type Row = {
  user_id: string;
  email: string;
  role: Role;
  is_disabled: boolean;
  employee_id: number | null;
  employee_name: string | null;
  created_at: string;
  last_login_at: string | null;
};

export function UsersClient({
  currentUserId,
  users,
}: {
  currentUserId: string;
  users: Row[];
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            href="/settings"
            className="text-sm text-muted-foreground hover:underline"
          >
            ← Settings
          </Link>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Invite people, change roles, disable access. Changes propagate
            on each user&rsquo;s next sign-in.
          </p>
        </div>
        <InviteDialog />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{users.length} user(s)</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Role</th>
                  <th className="px-3 py-2 text-left font-medium">
                    Linked employee
                  </th>
                  <th className="px-3 py-2 text-left font-medium">Last sign-in</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => (
                  <UserRow
                    key={u.user_id}
                    row={u}
                    isSelf={u.user_id === currentUserId}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({ row, isSelf }: { row: Row; isSelf: boolean }) {
  const [isPending, startTransition] = useTransition();

  function changeRole(role: Role) {
    if (role === row.role) return;
    startTransition(async () => {
      const r = await setUserRoleAction({ user_id: row.user_id, role });
      if (!r.ok) toast.error(r.error.detail);
      else toast.success(`Role set to ${role}.`);
    });
  }

  function toggleDisabled() {
    startTransition(async () => {
      const r = await setUserDisabledAction({
        user_id: row.user_id,
        disabled: !row.is_disabled,
      });
      if (!r.ok) toast.error(r.error.detail);
      else
        toast.success(row.is_disabled ? "Account enabled." : "Account disabled.");
    });
  }

  function resendInvitation() {
    startTransition(async () => {
      const r = await resendInvitationAction({ user_id: row.user_id });
      if (!r.ok) toast.error(r.error.detail);
      else toast.success(`Invitation re-sent to ${row.email}.`);
    });
  }

  function resetPassword() {
    if (
      !confirm(
        `Send a password-reset email to ${row.email}? They'll receive a code and pick a new password on the sign-in page.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await resetPasswordAction({ user_id: row.user_id });
      if (!r.ok) toast.error(r.error.detail);
      else toast.success(`Password-reset email sent to ${row.email}.`);
    });
  }

  function deleteUser() {
    if (
      !confirm(
        `Delete ${row.email}? This removes the Cognito account and the app record. Irreversible.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const r = await deleteUserAction({ user_id: row.user_id });
      if (!r.ok) toast.error(r.error.detail);
      else toast.success(`${row.email} deleted.`);
    });
  }

  const neverSignedIn = row.last_login_at === null;

  return (
    <tr className={row.is_disabled ? "bg-muted/30 text-muted-foreground" : ""}>
      <td className="px-3 py-2">
        <div className="font-medium">
          {row.email}
          {isSelf && (
            <span className="ml-2 text-xs text-muted-foreground">(you)</span>
          )}
          {row.is_disabled && (
            <Badge variant="outline" className="ml-2 text-xs">
              disabled
            </Badge>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap gap-1">
          {(["employee", "manager", "admin"] as const).map((r) => (
            <Button
              key={r}
              size="xs"
              variant={row.role === r ? "default" : "outline"}
              disabled={isPending || row.is_disabled}
              onClick={() => changeRole(r)}
            >
              {r}
            </Button>
          ))}
        </div>
      </td>
      <td className="px-3 py-2 text-muted-foreground">
        {row.employee_name ?? "—"}
        {row.employee_id !== null && (
          <span className="ml-2 text-xs tabular-nums">#{row.employee_id}</span>
        )}
      </td>
      <td className="px-3 py-2 text-muted-foreground tabular-nums">
        {row.last_login_at
          ? new Date(row.last_login_at).toLocaleString("de-DE")
          : "—"}
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex flex-wrap justify-end gap-2">
          {!isSelf && !row.is_disabled && (
            <Button
              size="xs"
              variant="ghost"
              disabled={isPending}
              onClick={neverSignedIn ? resendInvitation : resetPassword}
              title={
                neverSignedIn
                  ? "Re-send the invitation email"
                  : "Send a password-reset email"
              }
            >
              {neverSignedIn ? (
                <MailIcon className="size-3" />
              ) : (
                <KeyIcon className="size-3" />
              )}
              {neverSignedIn ? "Send again" : "Reset password"}
            </Button>
          )}
          {!isSelf && (
            <Button
              size="xs"
              variant={row.is_disabled ? "outline" : "ghost"}
              disabled={isPending}
              onClick={toggleDisabled}
            >
              {isPending && <Loader2Icon className="size-3 animate-spin" />}
              {row.is_disabled ? "Enable" : "Disable"}
            </Button>
          )}
          {!isSelf && row.is_disabled && (
            <Button
              size="xs"
              variant="ghost"
              disabled={isPending}
              onClick={deleteUser}
              className="text-destructive hover:text-destructive"
            >
              <Trash2Icon className="size-3" />
              Delete
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("employee");
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await inviteUserAction({ email, role });
      if (!r.ok) {
        toast.error(r.error.detail);
        return;
      }
      toast.success(`Invited ${r.data.email}.`);
      setOpen(false);
      setEmail("");
      setRole("employee");
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlusIcon className="size-4" /> Invite
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>
            In dev mode this just creates an <code>app_user</code> row. In
            production it will issue a Cognito <code>AdminCreateUser</code>{" "}
            call and Cognito will email the user a temp password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <Label>Role</Label>
            <div className="flex gap-2">
              {(["employee", "manager", "admin"] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={role === r ? "default" : "outline"}
                  onClick={() => setRole(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2Icon className="size-4 animate-spin" />}
              Send invite
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
