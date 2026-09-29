import { test } from "node:test";
import { strict as assert } from "node:assert";
import { z } from "zod";

import { CAPABILITIES } from "./capabilities";
import { coerceConfigValues, describeConfigSchema } from "./config-form";
import { parseRule, RULE_CATALOG, ruleDefinition } from "./rules";

test("rule catalog: every entry targets a known capability and has a valid fallback", () => {
  const seen = new Set<string>();
  for (const def of RULE_CATALOG) {
    assert.ok(CAPABILITIES.has(def.capability), `${def.capability} is not a capability`);
    const id = `${def.capability}.${def.key}`;
    assert.ok(!seen.has(id), `duplicate rule ${id}`);
    seen.add(id);
    assert.ok(def.schema.safeParse(def.fallback).success, `${id} fallback must satisfy its schema`);
  }
});

test("parseRule: accepts the seeded shapes and falls back on garbage", () => {
  assert.deepEqual(parseRule("time_entries", "overlap_policy", { kind: "day_wins", integration: "awork" }), {
    kind: "day_wins",
    integration: "awork",
  });
  assert.deepEqual(parseRule("time_entries", "overlap_policy", { kind: "nonsense" }), { kind: "merge" });
  assert.deepEqual(parseRule("people", "auto_link_email", { integrations: ["awork"] }), {
    integrations: ["awork"],
  });
  assert.deepEqual(parseRule("companies", "auto_link_name", null), { integrations: [] });
  const imp = parseRule<Record<string, unknown>>("projects", "import_policy", {
    integration: "awork",
    customers: true,
    projects: true,
    apply_money: true,
    refresh_dates: true,
  });
  assert.equal(imp.integration, "awork");
  // Unknown keys pass through untouched (forward compatibility).
  assert.deepEqual(parseRule("projects", "future_rule", { x: 1 }), { x: 1 });
  assert.equal(ruleDefinition("projects", "future_rule"), undefined);
});

test("describeConfigSchema: flat zod objects become field descriptors", () => {
  const schema = z
    .object({
      oauth_scope: z.string().describe("Scope").default("offline_access"),
      page_size: z.number().int().optional(),
      strict: z.boolean(),
      region: z.enum(["eu", "us"]).nullable(),
      weird: z.array(z.string()),
    })
    .passthrough();
  const fields = describeConfigSchema(schema);
  assert.deepEqual(
    fields.map((f) => [f.key, f.type, f.required, f.default, f.options]),
    [
      ["oauth_scope", "string", false, "offline_access", []],
      ["page_size", "number", false, undefined, []],
      ["strict", "boolean", true, undefined, []],
      ["region", "enum", false, undefined, ["eu", "us"]],
      ["weird", "json", true, undefined, []],
    ],
  );
  assert.equal(fields[0].description, "Scope");
  assert.equal(fields[0].label, "Oauth scope");
  assert.deepEqual(describeConfigSchema(z.object({})), []);

  const coerced = coerceConfigValues(fields, {
    oauth_scope: "x",
    page_size: "50",
    strict: "true",
    region: "",
    weird: '["a"]',
  });
  assert.deepEqual(coerced, { oauth_scope: "x", page_size: 50, strict: true, region: null, weird: ["a"] });
  assert.equal(fields[3].nullable, true);
  assert.equal(fields[1].nullable, false);
  assert.ok(schema.safeParse(coerced).success);
});
