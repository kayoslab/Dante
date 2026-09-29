/** Guard: provider adapters must stay read-only against their tools.
 *
 * Invariant: under `lib/integrations/providers/<slug>/`, the only files
 * that may issue an HTTP write are the ones the adapter itself declares in
 * `writesAllowedIn` (awork: `auth.ts`, for the OAuth token endpoint;
 * Personio: `client.ts`, for the POST /auth token exchange). Anything else
 * means someone added a write path against an external tool, which the
 * project forbids — Dante reads, it never pushes.
 *
 * The allow-list lives on the adapter, next to the code it describes, so
 * a new provider declares its own exceptions and they show up in review
 * with the adapter. Provider folders without a registered adapter are
 * scanned with an empty allow-list.
 *
 * Pure grep is sufficient — the surface is small and the false-positive
 * risk is low. Run via `npm run check:integration-readonly` (also wired
 * into `npm run check`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { PROVIDERS } from "../lib/integrations/core/registry";

const PROVIDERS_DIR = path.resolve("lib/integrations/providers");

// What counts as "issuing a write". Matched as substrings — these are the
// recognisable shapes that show up in TS HTTP clients. Add patterns here
// if a new HTTP client surfaces.
const WRITE_PATTERNS: RegExp[] = [
  /method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/,
  /\.(post|put|patch|delete)\s*\(/,
  /axios\.(post|put|patch|delete)/,
  /undici\.request[^)]*method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/,
];

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

type Hit = { file: string; line: number; text: string; pattern: string };

async function scanProvider(folder: string, allowed: Set<string>): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const file of await walk(folder)) {
    const rel = path.relative(folder, file);
    if (allowed.has(rel)) continue;
    const lines = (await fs.readFile(file, "utf-8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      // Strip line comments + trailing block comments so commentary
      // mentioning "POST" doesn't trigger.
      const stripped = lines[i].replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      for (const re of WRITE_PATTERNS) {
        if (re.test(stripped)) {
          hits.push({
            file: path.relative(process.cwd(), file),
            line: i + 1,
            text: lines[i].trim(),
            pattern: re.source,
          });
        }
      }
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const byFolder = new Map<string, Set<string>>();
  for (const p of PROVIDERS) byFolder.set(p.slug, new Set(p.writesAllowedIn));

  const entries = await fs.readdir(PROVIDERS_DIR, { withFileTypes: true });
  const hits: Hit[] = [];
  const scanned: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_")) continue;
    const allowed = byFolder.get(e.name) ?? new Set<string>();
    scanned.push(`${e.name} (allowed: ${[...allowed].join(", ") || "none"})`);
    hits.push(...(await scanProvider(path.join(PROVIDERS_DIR, e.name), allowed)));
  }

  if (hits.length === 0) {
    console.log(`✓ integration read-only guard: no write sites outside declared files — ${scanned.join("; ")}`);
    return;
  }
  console.error("✗ integration read-only guard FAILED — HTTP write detected outside the adapter's writesAllowedIn:\n");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  matched /${h.pattern}/`);
    console.error(`    ${h.text}`);
  }
  console.error(
    "\nIntegrations must stay read-only. If you genuinely need a new write path, discuss with",
  );
  console.error(
    "the owner first and add the file to `writesAllowedIn` on the adapter, with a comment explaining why.",
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
