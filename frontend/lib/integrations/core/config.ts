/** Load the admin-configured integration model for one sync run.
 *
 * Reads `integration`, `integration_binding` and `integration_rule` once
 * and hands the runner a plain, immutable snapshot. Bindings come back
 * per capability in priority order (0 = primary) with disabled bindings
 * and disabled integrations already filtered out.
 */
import type { Client } from "pg";

import { CAPABILITY_ORDER, isCapability, type Capability } from "./capabilities";
import type { IntegrationRecord } from "./types";

export type Binding = { capability: Capability; integration_slug: string; priority: number };

export type IntegrationConfig = {
  integrations: ReadonlyMap<string, IntegrationRecord>;
  /** Enabled bindings per capability, sorted by priority. */
  bindings: ReadonlyMap<Capability, readonly Binding[]>;
  /** `capability.key` → value. */
  rules: ReadonlyMap<string, Record<string, unknown>>;
};

export function ruleKey(capability: Capability, key: string): string {
  return `${capability}.${key}`;
}

export async function loadIntegrationConfig(conn: Client): Promise<IntegrationConfig> {
  const integrations = new Map<string, IntegrationRecord>();
  const ir = await conn.query<{
    slug: string;
    provider: string;
    display_name: string;
    enabled: boolean;
    config: Record<string, unknown> | null;
  }>(
    `SELECT slug, provider, display_name, enabled, config FROM integration ORDER BY slug`,
  );
  for (const r of ir.rows) {
    integrations.set(r.slug, {
      slug: r.slug,
      provider: r.provider,
      display_name: r.display_name,
      enabled: r.enabled,
      config: r.config ?? {},
    });
  }

  const bindings = new Map<Capability, Binding[]>();
  for (const c of CAPABILITY_ORDER) bindings.set(c, []);
  const br = await conn.query<{ capability: string; integration_slug: string; priority: number }>(
    `SELECT b.capability, b.integration_slug, b.priority
       FROM integration_binding b
       JOIN integration i ON i.slug = b.integration_slug
      WHERE b.enabled AND i.enabled
      ORDER BY b.capability, b.priority`,
  );
  for (const r of br.rows) {
    if (!isCapability(r.capability)) continue;
    bindings.get(r.capability)!.push({
      capability: r.capability,
      integration_slug: r.integration_slug,
      priority: r.priority,
    });
  }

  const rules = new Map<string, Record<string, unknown>>();
  const rr = await conn.query<{ capability: string; key: string; value: Record<string, unknown> }>(
    `SELECT capability, key, value FROM integration_rule`,
  );
  for (const r of rr.rows) {
    if (!isCapability(r.capability)) continue;
    rules.set(ruleKey(r.capability, r.key), r.value ?? {});
  }

  return { integrations, bindings, rules };
}

/** Integrations named in a rule's `integrations` list, or `integration`
 *  scalar — the two shapes the seeded rules use. */
export function ruleIntegrations(rule: Record<string, unknown> | undefined): string[] {
  if (!rule) return [];
  const list = rule.integrations;
  if (Array.isArray(list)) return list.filter((x): x is string => typeof x === "string");
  const one = rule.integration;
  return typeof one === "string" ? [one] : [];
}
