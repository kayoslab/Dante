"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Skeleton } from "@/components/ui/skeleton";

/** Standard loading/error/data shell for TanStack Query consumers.
 *
 * Replaces the repeated pattern:
 *
 *   {isLoading && <Skeleton className="h-40 w-full" />}
 *   {isError && <p className="text-sm text-red-600">…</p>}
 *   {data && <Content data={data} />}
 *
 * Usage:
 *
 *   const q = useFoo();
 *   <QueryGuard query={q}>
 *     {(data) => <FooContent data={data} />}
 *   </QueryGuard>
 *
 * Customize the skeleton via `skeletonHeight` (e.g. `"h-60"`) or pass a
 * custom `skeleton` node. The error message extracts `.message` from
 * the thrown Error.
 */
export function QueryGuard<T>({
  query,
  children,
  skeletonHeight = "h-40",
  skeleton,
  empty,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  /** Tailwind height class for the default skeleton. Default `h-40`. */
  skeletonHeight?: string;
  /** Override the skeleton entirely (e.g. a custom shape). */
  skeleton?: ReactNode;
  /** Optional override for the "no data" state. By default the children
   *  function is called with the data when it arrives. */
  empty?: ReactNode;
}) {
  if (query.isLoading) {
    return skeleton ?? <Skeleton className={`${skeletonHeight} w-full`} />;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-red-600">
        {query.error instanceof Error
          ? query.error.message
          : "Failed to load"}
      </p>
    );
  }
  if (query.data === undefined) {
    return empty ?? null;
  }
  return <>{children(query.data)}</>;
}
