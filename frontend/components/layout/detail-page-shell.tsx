"use client";

import { use } from "react";
import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";

/** Standard chrome for `/<entity>/[id]` pages.
 *
 * Handles three repeating concerns:
 *  1. Unwraps the async `params` (Next 15+ pattern: `params` is a Promise).
 *  2. Parses the id (default `Number`) and calls the supplied detail hook.
 *  3. Renders Skeleton-on-load and a red error block on error.
 *
 * Pass the `useDetail` hook function (e.g. `useEmployee`) and a render
 * prop that consumes the resolved entity:
 *
 *   export default function EmployeePage({ params }: PageProps) {
 *     return (
 *       <DetailPageShell params={params} useDetail={useEmployee}>
 *         {(employee) => <EmployeeBody employee={employee} />}
 *       </DetailPageShell>
 *     );
 *   }
 *
 * If your id parser is non-numeric, pass `parseId`. If your loading or
 * error UI needs to differ from the defaults, override via the props.
 */
export function DetailPageShell<TData, TId = number>({
  params,
  useDetail,
  parseId = (raw: string) => Number(raw) as unknown as TId,
  children,
  skeleton,
}: {
  params: Promise<{ id: string }>;
  useDetail: (id: TId) => UseQueryResult<TData>;
  parseId?: (raw: string) => TId;
  children: (data: TData) => ReactNode;
  skeleton?: ReactNode;
}) {
  const { id: rawId } = use(params);
  const id = parseId(rawId);
  const query = useDetail(id);

  if (query.isLoading) {
    return (
      skeleton ?? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-32 w-full" />
        </div>
      )
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        Failed to load:{" "}
        {query.error instanceof Error ? query.error.message : "unknown"}
      </div>
    );
  }
  return <>{children(query.data)}</>;
}
