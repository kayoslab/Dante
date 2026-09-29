/** Read-only HTTP client for the example tool.
 *
 * Keep the transport GET-only. If your tool's auth needs a POST (an OAuth
 * token exchange, an API-key → session-token swap), put that in its own
 * file and list the file in the adapter's `writesAllowedIn` — the
 * read-only guard (`npm run check:integration-readonly`) fails the build
 * on any other write.
 *
 * Validate at the boundary: parse each item with zod and drop malformed
 * ones with a warning, so one odd row never aborts a sync.
 */
import { z } from "zod";

import { log } from "@/lib/logger";

const API_BASE = "https://api.example.com/v1";

export const ExamplePersonSchema = z
  .object({
    id: z.string(),
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    email: z.string().nullish(),
    archived: z.boolean().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();
export type ExamplePerson = z.infer<typeof ExamplePersonSchema>;

export const ExampleProjectSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    clientId: z.string().nullish(),
    billable: z.boolean().nullish(),
    status: z.string().nullish(),
    updatedAt: z.string().nullish(),
  })
  .passthrough();
export type ExampleProject = z.infer<typeof ExampleProjectSchema>;

export const ExampleTimeEntrySchema = z
  .object({
    id: z.string(),
    personId: z.string().nullish(),
    projectId: z.string().nullish(),
    date: z.string(),
    minutes: z.number(),
    note: z.string().nullish(),
  })
  .passthrough();
export type ExampleTimeEntry = z.infer<typeof ExampleTimeEntrySchema>;

/** The surface the adapter needs. Keeping it an interface lets tests pass
 * a fake without touching the network. */
export interface ExampleClient {
  listPersons(): Promise<ExamplePerson[]>;
  listProjects(opts?: { updated_since?: string | null }): Promise<ExampleProject[]>;
  listTimeEntries(window: { start_date: string; end_date: string }): Promise<ExampleTimeEntry[]>;
}

function parseList<T>(schema: z.ZodType<T>, items: unknown[], resource: string): T[] {
  const out: T[] = [];
  for (const raw of items) {
    const r = schema.safeParse(raw);
    if (r.success) out.push(r.data);
    else log.warn("example_parse_failed", { resource, issue: r.error.issues[0]?.message });
  }
  return out;
}

export function createExampleClient(apiKey: string): ExampleClient {
  async function get(path: string, params: Record<string, string> = {}): Promise<unknown[]> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const r = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } });
    if (!r.ok) throw new Error(`example GET ${path} → ${r.status}`);
    const body = (await r.json()) as { data?: unknown[] };
    return body.data ?? [];
  }
  return {
    listPersons: async () => parseList(ExamplePersonSchema, await get("/persons"), "person"),
    listProjects: async (opts = {}) =>
      parseList(
        ExampleProjectSchema,
        await get("/projects", opts.updated_since ? { updated_since: opts.updated_since } : {}),
        "project",
      ),
    listTimeEntries: async (window) =>
      parseList(ExampleTimeEntrySchema, await get("/time-entries", { from: window.start_date, to: window.end_date }), "time_entry"),
  };
}
