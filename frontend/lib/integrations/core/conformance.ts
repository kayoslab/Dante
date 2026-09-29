/** Adapter conformance suite.
 *
 * `describeAdapter(adapter, options)` registers node:test cases that every
 * provider must pass, without a database or network:
 *
 *   1. the manifest is well-formed (slug, auth spec, config schema accepts
 *      an empty object, capabilities are known);
 *   2. every declared capability has its pull method and every pull method
 *      has its capability — a method without a binding would silently
 *      never run;
 *   3. every file named in `writesAllowedIn` exists in the provider folder
 *      (when `dir` is given), so the read-only guard's allow-list can't
 *      drift from the code;
 *   4. with `fixtures`, each pull method is run against a fake client and
 *      its output is validated against the canonical record schema.
 *
 * Use it from the provider's own test file:
 *
 *   describeAdapter(myAdapter, {
 *     dir: import.meta.dirname,
 *     fixtures: { projects: { client: fakeClient, opts: { full: true } } },
 *   });
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import path from "node:path";

import { CAPABILITY_RECORD_SCHEMA } from "./canonical-schemas";
import { CAPABILITY_ORDER, isCapability, type Capability } from "./capabilities";
import { CAPABILITY_METHOD, type ProviderAdapter, type PullContext } from "./types";

export type CapabilityFixture = {
  /** The fake client the pull method receives. */
  client: unknown;
  /** Options for catalog / time-entry pulls (`full`, `window`). */
  opts?: Record<string, unknown>;
  /** Window for absences. */
  window?: { start_date: string; end_date: string };
  /** Expected number of records, when the fixture makes that known. */
  expectCount?: number;
};

export type DescribeAdapterOptions = {
  /** The provider folder, to check `writesAllowedIn` entries exist. */
  dir?: string;
  fixtures?: Partial<Record<Capability, CapabilityFixture>>;
};

export function stubPullContext(slug: string, overrides: Partial<PullContext> = {}): PullContext {
  return {
    integration: { slug, provider: slug, display_name: slug, enabled: true, config: {} },
    sync_run_id: 0,
    log: () => {},
    highWaterMark: async () => null,
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function describeAdapter(adapter: ProviderAdapter<any, any>, options: DescribeAdapterOptions = {}): void {
  const name = `adapter ${adapter.slug}`;

  test(`${name}: manifest is well-formed`, () => {
    assert.match(adapter.slug, /^[a-z][a-z0-9_-]*$/, "slug is a lower-case identifier");
    assert.ok(adapter.displayName.length > 0, "displayName is set");
    assert.ok(["api_key", "client_credentials", "oauth2_pkce"].includes(adapter.auth.kind), "auth.kind is known");
    assert.ok(adapter.auth.fields.length > 0, "auth.fields names the credential inputs");
    for (const f of adapter.auth.fields) {
      assert.match(f.key, /^[a-z][a-z0-9_]*$/, `credential field key "${f.key}" is snake_case`);
      assert.ok(f.label.length > 0, `credential field "${f.key}" has a label`);
    }
    if (adapter.auth.kind === "oauth2_pkce") {
      assert.ok(adapter.auth.authorizeUrl.startsWith("https://"), "authorizeUrl is https");
      assert.ok(adapter.auth.tokenUrl.startsWith("https://"), "tokenUrl is https");
    }
    assert.ok(adapter.capabilities.length > 0, "declares at least one capability");
    assert.equal(new Set(adapter.capabilities).size, adapter.capabilities.length, "capabilities are unique");
    assert.ok(adapter.configSchema.safeParse({}).success, "configSchema accepts an empty config");
    assert.ok(Array.isArray(adapter.writesAllowedIn), "writesAllowedIn is a list");
    assert.equal(typeof adapter.createClient, "function");
    assert.equal(typeof adapter.healthCheck, "function");
  });

  test(`${name}: capabilities and pull methods match`, () => {
    for (const cap of adapter.capabilities) {
      assert.ok(isCapability(cap), `${cap} is not a known capability`);
      const method = CAPABILITY_METHOD[cap];
      assert.equal(typeof adapter[method], "function", `declares ${cap} but has no ${method}()`);
    }
    for (const cap of CAPABILITY_ORDER) {
      const method = CAPABILITY_METHOD[cap];
      if (typeof adapter[method] === "function") {
        assert.ok(adapter.capabilities.includes(cap), `has ${method}() but does not declare ${cap}`);
      }
    }
  });

  if (options.dir) {
    const dir = options.dir;
    test(`${name}: writesAllowedIn files exist`, () => {
      for (const f of adapter.writesAllowedIn) {
        assert.ok(existsSync(path.join(dir, f)), `writesAllowedIn names a missing file: ${f}`);
      }
    });
  }

  for (const [cap, fixture] of Object.entries(options.fixtures ?? {}) as Array<[Capability, CapabilityFixture]>) {
    test(`${name}: ${cap} emits canonical records`, async () => {
      assert.ok(adapter.capabilities.includes(cap), `fixture for undeclared capability ${cap}`);
      const method = CAPABILITY_METHOD[cap];
      const fn = adapter[method] as (...args: unknown[]) => Promise<unknown>;
      const ctx = stubPullContext(adapter.slug);
      const { schema, envelope } = CAPABILITY_RECORD_SCHEMA[cap];
      const args: unknown[] = [fixture.client, ctx];
      if (cap === "absences") args.push(fixture.window ?? { start_date: "2026-01-01", end_date: "2026-12-31" });
      else if (cap === "time_entries") {
        args.push({ full: true, window: { start_date: "2026-01-01", end_date: "2026-12-31" }, ...(fixture.opts ?? {}) });
      } else if (cap === "companies" || cap === "projects") args.push({ full: true, ...(fixture.opts ?? {}) });
      const result = await fn.call(adapter, ...args);
      let records: unknown[];
      if (envelope) {
        const env = result as { records?: unknown; mode?: unknown };
        assert.ok(Array.isArray(env.records), `${method}() must return { records, mode }`);
        assert.ok(env.mode === "full" || env.mode === "incremental", `${method}() mode must be full | incremental`);
        records = env.records;
      } else {
        assert.ok(Array.isArray(result), `${method}() must return an array`);
        records = result as unknown[];
      }
      if (fixture.expectCount !== undefined) assert.equal(records.length, fixture.expectCount);
      const ids = new Set<string>();
      records.forEach((r, i) => {
        const parsed = schema.safeParse(r);
        assert.ok(parsed.success, `${method}() record ${i} is not canonical: ${parsed.success ? "" : parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
        const id = (r as { external_id: string }).external_id;
        assert.ok(!ids.has(id), `${method}() emitted external_id "${id}" twice`);
        ids.add(id);
      });
    });
  }
}
