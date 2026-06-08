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
          staleTime: 30_000,
          refetchOnWindowFocus: true,
        },
      },
    }),
);
