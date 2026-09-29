/** Registry sanity + the conformance suite for every registered provider.
 * Runs without a database or network; fixture-based pull checks live in
 * each provider's own test file. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";

import { describeAdapter } from "./conformance";
import { PROVIDERS, getAdapter } from "./registry";

test("registry: slugs are unique and resolvable", () => {
  const slugs = PROVIDERS.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const p of PROVIDERS) assert.equal(getAdapter(p.slug), p);
  assert.equal(getAdapter("nope"), undefined);
});

for (const adapter of PROVIDERS) {
  describeAdapter(adapter, { dir: path.join(__dirname, "..", "providers", adapter.slug) });
}
