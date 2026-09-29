"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Plug, RefreshCw, ScrollText, Users } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useSettings,
  useUpdateSetting,
  type Setting,
} from "@/lib/api/settings";
import { TeamsCard } from "@/components/team/teams-card";

export function SettingsClient() {
  const { data, isLoading, isError, error } = useSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Application-wide configuration. New keys appear here automatically
          once written to the <code>setting</code> table.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <Users className="size-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Users</div>
                <div className="text-xs text-muted-foreground">
                  Invite people, change roles, disable access.
                </div>
              </div>
            </div>
            <Link
              href="/settings/users"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Open
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <ScrollText className="size-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Audit log</div>
                <div className="text-xs text-muted-foreground">
                  Sign-ins, role changes, admin actions, sensitive views.
                </div>
              </div>
            </div>
            <Link
              href="/settings/audit"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Open
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <Plug className="size-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Integrations</div>
                <div className="text-xs text-muted-foreground">
                  Connected tools, credentials, authorization status.
                </div>
              </div>
            </div>
            <Link
              href="/settings/integrations"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Open
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-4">
            <div className="flex items-center gap-3">
              <RefreshCw className="size-5 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Run sync</div>
                <div className="text-xs text-muted-foreground">
                  Pull fresh Personio + awork data into the database.
                </div>
              </div>
            </div>
            <Link
              href="/settings/sync"
              className={buttonVariants({ size: "sm", variant: "outline" })}
            >
              Open
            </Link>
          </CardContent>
        </Card>
      </div>

      <TeamsCard />

      {isLoading && (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}
      {isError && (
        <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Failed to load: {error instanceof Error ? error.message : "unknown"}
        </div>
      )}
      {data && data.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No settings configured yet.
          </CardContent>
        </Card>
      )}
      {data?.map((s) => (
        <SettingCard key={s.key} setting={s} />
      ))}
    </div>
  );
}

function SettingCard({ setting }: { setting: Setting }) {
  const [value, setValue] = useState(setting.value);
  const update = useUpdateSetting();
  const dirty = value !== setting.value;

  async function save() {
    try {
      await update.mutateAsync({ key: setting.key, value });
      toast.success(`${setting.key} updated`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-mono text-base">{setting.key}</CardTitle>
        {setting.description && (
          <p className="text-sm text-muted-foreground">{setting.description}</p>
        )}
      </CardHeader>
      <CardContent className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            className="font-mono"
          />
          {setting.updated_at && (
            <p className="mt-1 text-xs text-muted-foreground tabular-nums">
              updated {setting.updated_at}
            </p>
          )}
        </div>
        <Button
          onClick={save}
          disabled={!dirty || update.isPending}
          size="sm"
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        {dirty && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setValue(setting.value)}
            disabled={update.isPending}
          >
            Reset
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
