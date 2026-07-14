/** Read-only HTTP client for the awork API.
 *
 * By transport invariant, this client only issues GET requests. The
 * only POST surface in the codebase lives in `./auth.ts` and is
 * hardcoded to the OAuth token endpoint — enforced by
 * `scripts/check-awork-readonly.ts`.
 *
 * The `list*` methods Zod-validate each item at the boundary so the sync
 * layer downstream sees typed values, not `Record<string, unknown>`.
 * Malformed items are dropped (logged) rather than crashing the sync —
 * one bad row from awork shouldn't stop today's data refresh.
 */
import { getValidAccessToken } from "./auth";
import {
  AworkCompanySchema,
  AworkCustomFieldDefinitionSchema,
  AworkProjectSchema,
  AworkTimeBookingSchema,
  AworkTimeEntrySchema,
  AworkUserSchema,
  parseList,
  type AworkCompany,
  type AworkCustomFieldDefinition,
  type AworkProject,
  type AworkTimeBooking,
  type AworkTimeEntry,
  type AworkUser,
} from "./schemas";

const API_BASE = "https://api.awork.com/api/v1";

export class AworkWriteAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AworkWriteAttemptError";
  }
}

async function awGet(
  path: string,
  params: Record<string, string | number | undefined> = {},
): Promise<unknown> {
  const token = await getValidAccessToken();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) {
    throw new Error(
      `awork GET ${path} → ${r.status} ${(await r.text()).slice(0, 300)}`,
    );
  }
  return r.json();
}

async function paginate(
  path: string,
  params: Record<string, string | number | undefined> = {},
  page_size = 200,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let page = 1;
  while (true) {
    const data = await awGet(path, {
      ...params,
      page,
      pageSize: page_size,
    });
    let pageItems: unknown[];
    if (Array.isArray(data)) {
      pageItems = data;
    } else if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { data?: unknown[] }).data)
    ) {
      pageItems = (data as { data: unknown[] }).data;
    } else {
      throw new Error(
        `unexpected awork list response shape for ${path}: ${typeof data}`,
      );
    }
    items.push(...pageItems);
    if (pageItems.length < page_size) break;
    page += 1;
  }
  return items;
}

/** OData delta-filter params for a full-scan `list*` pull. When
 * `updated_since` is set, ask awork for only the rows whose `updatedOn`
 * is at or after our high-water mark, sorted ascending so pagination
 * stays stable while rows change. `ge` (not `gt`) re-includes the
 * boundary row on every run — harmless because each downstream write is
 * an idempotent upsert, and it closes the equal-timestamp gap a strict
 * `gt` would silently drop. `updated_since` must be a bare OData datetime
 * literal body (`YYYY-MM-DDTHH:MM:SS`, no timezone suffix); the caller in
 * `sync.ts` (`aworkMaxUpdatedOn`) formats it. */
function deltaParams(
  updated_since: string | null | undefined,
): Record<string, string> {
  if (!updated_since) return {};
  return {
    filterby: `updatedOn ge datetime'${updated_since}'`,
    orderby: "updatedOn asc",
  };
}

/** Public read-only surface. Adding any non-`list*`/`get*` method here
 * MUST be reviewed — the invariant is enforced both by convention and by
 * the GET-only transport above. */
export const aworkClient = {
  // `updated_since` (optional) turns the full-catalog pull into a delta
  // pull via `deltaParams`. Omit it (or pass null) for a full scan.
  listProjects: async (
    opts: { updated_since?: string | null } = {},
  ): Promise<AworkProject[]> =>
    parseList(
      AworkProjectSchema,
      await paginate("/projects", deltaParams(opts.updated_since)),
      "project",
    ),
  listCustomFieldDefinitions: async (): Promise<AworkCustomFieldDefinition[]> =>
    parseList(
      AworkCustomFieldDefinitionSchema,
      await paginate("/customfielddefinitions"),
      "custom_field_definition",
    ),
  listUsers: async (): Promise<AworkUser[]> =>
    parseList(AworkUserSchema, await paginate("/users"), "user"),
  listClients: async (
    opts: { updated_since?: string | null } = {},
  ): Promise<AworkCompany[]> =>
    parseList(
      AworkCompanySchema,
      await paginate("/companies", deltaParams(opts.updated_since)),
      "company",
    ),
  listTimeEntries: async (params: {
    start_date: string;
    end_date: string;
  }): Promise<AworkTimeEntry[]> =>
    parseList(
      AworkTimeEntrySchema,
      await paginate("/timeentries", {
        startDate: params.start_date,
        endDate: params.end_date,
      }),
      "time_entry",
    ),
  // `/timebookings` powers awork's Planner. No date-range filter on the
  // endpoint — we pull everything and let the calendar query slice by
  // employee+date. With ~200 entries per workspace per quarter the
  // payload stays small even over a year of history.
  listTimeBookings: async (): Promise<AworkTimeBooking[]> =>
    parseList(
      AworkTimeBookingSchema,
      await paginate("/timebookings"),
      "time_booking",
    ),
  // `list*` methods filter through the boundary schema. The two raw
  // accessors below stay typed as `unknown` because they're rarely
  // used and the consumers don't actually read fields — they just
  // forward the payload.
  listProjectTasks: (project_id: string): Promise<unknown[]> =>
    paginate(`/projects/${project_id}/projecttasks`),
  getProject: (project_id: string): Promise<unknown> =>
    awGet(`/projects/${project_id}`),
  getUser: (user_id: string): Promise<unknown> => awGet(`/users/${user_id}`),
} as const;

export type AworkClient = typeof aworkClient;
