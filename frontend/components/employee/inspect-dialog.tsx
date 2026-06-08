"use client";

import { useState } from "react";
import { Bug } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeInspect } from "@/lib/api/inspect";

type Props = {
  employeeId: number;
  employeeName: string;
};

export function InspectDialog({ employeeId, employeeName }: Props) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useEmployeeInspect(
    employeeId,
    open,
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Bug className="mr-1.5 h-4 w-4" />
            Inspect raw Personio data
          </Button>
        }
      />
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Raw Personio attributes — {employeeName}</DialogTitle>
          <DialogDescription>
            Latest snapshot from <code>raw_employee_snapshot</code>. Useful
            when you need to know whether a field is missing from Personio
            entirely vs. just not mapped here.
            {data?.sync_started_at && (
              <span className="block mt-1 text-xs">
                Snapshot from{" "}
                <span className="tabular-nums">{data.sync_started_at}</span>{" "}
                (sync_run_id {data.sync_run_id})
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        )}
        {isError && (
          <p className="text-sm text-red-600">
            {error instanceof Error ? error.message : "Failed"}
          </p>
        )}
        {data && (
          <div className="min-h-0 flex-1 overflow-y-auto rounded border bg-muted/30">
            <table className="w-full text-xs">
              <tbody className="divide-y">
                {Object.entries(data.attributes)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => (
                    <tr key={k} className="align-top">
                      <th className="w-1/3 px-3 py-2 text-left font-mono font-medium">
                        {k}
                      </th>
                      <td className="px-3 py-2 font-mono break-all text-muted-foreground">
                        {renderValue(v)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function renderValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return JSON.stringify(v, null, 2);
}
