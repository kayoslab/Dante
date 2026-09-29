/** Adapter conformance: every registered provider declares a consistent
 * manifest, and every capability it claims has the matching pull method.
 * Runs without a database or network. */
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { CAPABILITY_ORDER, isCapability } from "./capabilities";
import { PROVIDERS, getAdapter } from "./registry";
import { CAPABILITY_METHOD } from "./types";

test("registry: slugs are unique and resolvable", () => {
  const slugs = PROVIDERS.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const p of PROVIDERS) assert.equal(getAdapter(p.slug), p);
  assert.equal(getAdapter("nope"), undefined);
});

for (const adapter of PROVIDERS) {
  test(`adapter ${adapter.slug}: manifest is well-formed`, () => {
    assert.match(adapter.slug, /^[a-z][a-z0-9_-]*$/);
    assert.ok(adapter.displayName.length > 0);
    assert.ok(["api_key", "client_credentials", "oauth2_pkce"].includes(adapter.auth.kind));
    assert.ok(adapter.auth.fields.length > 0, "auth.fields must name the credential inputs");
    assert.ok(adapter.capabilities.length > 0);
    assert.ok(adapter.configSchema.safeParse({}).success, "an empty config must be valid");
    assert.ok(Array.isArray(adapter.writesAllowedIn));
  });

  test(`adapter ${adapter.slug}: every declared capability has its pull method`, () => {
    for (const cap of adapter.capabilities) {
      assert.ok(isCapability(cap), `${cap} is not a known capability`);
      const method = CAPABILITY_METHOD[cap];
      assert.equal(typeof adapter[method], "function", `${adapter.slug} declares ${cap} but has no ${method}()`);
    }
    // And nothing undeclared: a pull method without its capability would
    // silently never run.
    for (const cap of CAPABILITY_ORDER) {
      const method = CAPABILITY_METHOD[cap];
      if (typeof adapter[method] === "function") {
        assert.ok(adapter.capabilities.includes(cap), `${adapter.slug} has ${method}() but does not declare ${cap}`);
      }
    }
  });
}
