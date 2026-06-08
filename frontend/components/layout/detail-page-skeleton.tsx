import { Skeleton } from "@/components/ui/skeleton";

/** Generic skeleton matching the shape of detail pages rendered by
 * `DetailPageShell`. Used by per-route `loading.tsx` files so the
 * nav-to-detail window shows recognizable chrome instead of empty space.
 */
export function DetailPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-20" />
        </div>
      </div>
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}
