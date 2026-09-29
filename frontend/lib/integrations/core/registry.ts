/** Static registry of provider adapters.
 *
 * An `integration` row's `provider` column names an entry here. Adding a
 * tool to Dante means writing an adapter under `providers/<slug>/` and
 * listing it below — nothing else in the core changes. Importing this
 * module must stay side-effect free (no env reads, no network), because
 * the read-only guard and the conformance test import it at build time.
 */
import type { ProviderAdapter } from "./types";

import { aworkAdapter } from "../providers/awork/adapter";
import { personioAdapter } from "../providers/personio/adapter";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = ProviderAdapter<any, any>;

export const PROVIDERS: readonly AnyAdapter[] = [personioAdapter, aworkAdapter];

export function getAdapter(provider: string): AnyAdapter | undefined {
  return PROVIDERS.find((p) => p.slug === provider);
}
