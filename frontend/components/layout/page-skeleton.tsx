import { Skeleton } from "@/components/ui/skeleton";

/** Generic fallbacks for per-route `loading.tsx` files. With Cache
 * Components each route needs its own Suspense boundary (a boundary in
 * the root layout doesn't cover client navigations below it); these
 * give the prerendered shell a recognizable page shape while the
 * session-gated content streams in. */
export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** Title + KPI row + chart block, matching the report pages. */
export function ReportPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
