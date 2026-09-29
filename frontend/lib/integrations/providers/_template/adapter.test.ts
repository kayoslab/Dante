/** The template passes the conformance suite with a fake client — copy this
 * file along with the adapter and swap the fixtures for your tool's
 * shapes. Runs with `npm test`; no database, no network. */
import { describeAdapter } from "@/lib/integrations/core/conformance";

import { exampleAdapter } from "./adapter";
import type { ExampleClient } from "./client";

const fakeClient: ExampleClient = {
  async listPersons() {
    return [
      { id: "p-1", firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", archived: false, updatedAt: "2026-01-02T10:00:00Z" },
      { id: "p-2", firstName: "Grace", lastName: null, email: null, archived: true, updatedAt: null },
    ];
  },
  async listProjects() {
    return [
      { id: "pr-1", name: "Engine", clientId: "c-1", billable: true, status: "active", updatedAt: "2026-01-03T00:00:00Z" },
      { id: "pr-2", name: "Archive cleanup", clientId: null, billable: false, status: "closed", updatedAt: null },
    ];
  },
  async listTimeEntries() {
    return [
      { id: "t-1", personId: "p-1", projectId: "pr-1", date: "2026-01-05", minutes: 90, note: "review" },
      { id: "t-2", personId: null, projectId: "pr-1", date: "2026-01-06T09:00:00Z", minutes: 30.4, note: null },
    ];
  },
};

describeAdapter(exampleAdapter, {
  dir: __dirname,
  fixtures: {
    external_contributors: { client: fakeClient, expectCount: 2 },
    projects: { client: fakeClient, expectCount: 2 },
    time_entries: { client: fakeClient, expectCount: 2 },
  },
});
