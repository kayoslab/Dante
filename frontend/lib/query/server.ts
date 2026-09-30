/** Per-request QueryClient for Server Components.
 *
 * `React.cache` keeps the instance request-scoped — Next.js's Server
 * Component runtime creates one per request, so concurrent users never
 * share state. Same defaultOptions as the client-side `Providers` so
 * prefetched queries behave identically once the client takes over.
 */
import "server-only";

import { QueryClient } from "@tanstack/react-query";
import { cache } from "react";

export const getQueryClient = cache(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          // 60s: every report page re-queried its expensive /api/reports/*
          // endpoints on each tab switch with the old 30s window. Reports
          // are month-granular, so a minute of staleness is invisible and
          // halves the focus-triggered refetch load on RDS.
          staleTime: 60_000,
          refetchOnWindowFocus: true,
        },
      },
    }),
);
