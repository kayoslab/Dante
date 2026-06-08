"use client";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDeleteButton } from "@/components/ui/confirm-delete-button";
import { useDeleteAssignment } from "@/lib/api/assignments";
import type { ProjectAssignment } from "@/lib/api/projects";
import { EditAssignmentDialog } from "./edit-assignment-dialog";
import { formatRate } from "@/lib/format";

export function AssignmentsTable({
  project_id,
  assignments,
}: {
  project_id: number;
  assignments: ProjectAssignment[];
}) {
  const del = useDeleteAssignment(project_id);

  if (assignments.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No assignments yet. Click <strong>Allocate</strong> to staff someone.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Who</TableHead>
          <TableHead>Profile</TableHead>
          <TableHead className="text-right">Alloc</TableHead>
          <TableHead className="text-right">Rate (€/d)</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Window</TableHead>
          <TableHead className="w-20"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {assignments.map((a) => (
          <TableRow key={a.assignment_id}>
            <TableCell>
              <span className="font-medium">{a.who_name}</span>{" "}
              <Badge variant="outline" className="ml-1">
                {a.kind === "employee" ? "emp" : "ext"}
              </Badge>
            </TableCell>
            <TableCell>
              {a.effective_profile ?? a.profile ?? "—"}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {Number(a.allocation_pct).toFixed(2)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {formatRate(a.effective_daily_rate_eur)}
            </TableCell>
            <TableCell>
              <Badge variant="secondary">{a.rate_source ?? "—"}</Badge>
            </TableCell>
            <TableCell className="text-sm tabular-nums">
              {a.start_date} → {a.end_date ?? "ongoing"}
            </TableCell>
            <TableCell>
              <div className="flex gap-1">
                <EditAssignmentDialog
                  projectId={project_id}
                  assignment={a}
                />
                <ConfirmDeleteButton
                  title={`Delete assignment for ${a.who_name}?`}
                  description="This removes the allocation from the project. Personnel cost calculations will update at the next view refresh. This cannot be undone."
                  successMessage="Assignment deleted"
                  onConfirm={() => del.mutateAsync(a.assignment_id)}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
