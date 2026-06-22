"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2Icon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { APIError } from "@/lib/api/types";
import {
  runSyncAction,
  type RunSyncSuccess,
} from "@/lib/actions/sync";

type Source = "all" | "personio" | "awork";

const SOURCE_LABEL: Record<Source, string> = {
  all: "Sync all",
  personio: "Personio only",
  awork: "awork only",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s - m * 60);
  return `${m}m ${rs}s`;
}

export function SyncCard() {
  const [output, setOutput] = useState<{
    source: Source;
    duration_ms: number;
    log: string;
  } | null>(null);
  const [runningSource, setRunningSource] = useState<Source | null>(null);

  const sync = useMutation<RunSyncSuccess, Error, Source>({
    mutationFn: async (source) => {
      setRunningSource(source);
      const r = await runSyncAction({ source });
      if (!r.ok) throw new APIError(r.error.detail, r.error.code);
      return r.data;
    },
    onSuccess: (data) => {
      setOutput(data);
      toast.success(
        `${SOURCE_LABEL[data.source]} finished in ${formatDuration(data.duration_ms)}`,
      );
    },
    onError: (e) => {
      toast.error(e.message);
      // Surface the captured logs (if any) for debugging — APIError.detail
      // carries them appended after the error string.
      setOutput({
        source: runningSource ?? "all",
        duration_ms: 0,
        log: e.message,
      });
    },
    onSettled: () => {
      setRunningSource(null);
    },
  });

  const isRunning = sync.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run sync</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {(["all", "personio", "awork"] as const).map((source) => {
            const thisIsRunning = runningSource === source;
            const otherIsRunning = isRunning && !thisIsRunning;
            return (
              <Button
                key={source}
                variant={source === "all" ? "default" : "outline"}
                disabled={isRunning}
                onClick={() => sync.mutate(source)}
              >
                {thisIsRunning ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-4" />
                )}
                <span className={otherIsRunning ? "opacity-60" : ""}>
                  {SOURCE_LABEL[source]}
                </span>
              </Button>
            );
          })}
        </div>

        {isRunning && runningSource && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Running {SOURCE_LABEL[runningSource]}… this can take a couple
            minutes for a full sync. The window stays open; output appears
            below when finished.
          </div>
        )}

        {output && !isRunning && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Last run: {SOURCE_LABEL[output.source]}
                {output.duration_ms > 0 &&
                  ` · ${formatDuration(output.duration_ms)}`}
              </span>
              <button
                type="button"
                className="hover:text-foreground"
                onClick={() => setOutput(null)}
              >
                clear
              </button>
            </div>
            <pre className="max-h-96 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed">
              {output.log || "(no output)"}
            </pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
