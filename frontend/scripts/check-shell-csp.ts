/** Post-build guard: every inline `<script>` in the prerendered static
 * shells must be allowed by hash in `lib/csp/shell-hashes.ts`.
 *
 * Why: under Cache Components the shells are rendered at build time and
 * carry no CSP nonce. `proxy.ts` allows their external chunks via
 * `'self'` and their inline scripts via sha256 hashes. If a Next.js or
 * React upgrade adds an inline script to the shell, the browser blocks
 * it, hydration dies, and nothing in `npm run check` would notice — so
 * this runs right after `next build` in the Dockerfile and fails the
 * image build with the offending hash and snippet.
 *
 * Usage: `npm run check:shell-csp` (needs a completed `next build`).
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { SHELL_CSP_EXEMPT, SHELL_INLINE_SCRIPT_HASHES } from "../lib/csp/shell-hashes";

const APP_DIR = path.join(process.cwd(), ".next", "server", "app");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".html")) out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  let files: string[];
  try {
    files = await walk(APP_DIR);
  } catch {
    console.error(`✗ shell-csp guard: ${APP_DIR} not found — run \`next build\` first.`);
    process.exit(2);
  }
  const allowed = new Set(SHELL_INLINE_SCRIPT_HASHES);
  const seen = new Set<string>();
  const violations: string[] = [];
  let shells = 0;
  for (const file of files) {
    if (SHELL_CSP_EXEMPT.has(path.basename(file))) continue;
    shells++;
    const html = await fs.readFile(file, "utf-8");
    for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
      const [, attrs, body] = m;
      if (/\bsrc=/.test(attrs)) continue; // external: allowed by 'self'
      if (/\bnonce=/.test(attrs)) continue; // never true in a shell, but harmless
      const hash = "sha256-" + createHash("sha256").update(body).digest("base64");
      seen.add(hash);
      if (!allowed.has(hash)) {
        violations.push(
          `${path.relative(process.cwd(), file)}: unlisted inline script ${hash}\n    ${body.slice(0, 100)}${body.length > 100 ? "…" : ""}`,
        );
      }
    }
  }
  if (shells === 0) {
    console.error("✗ shell-csp guard: no prerendered shells found (is cacheComponents on?).");
    process.exit(2);
  }
  if (violations.length > 0) {
    console.error(`✗ shell-csp guard: ${violations.length} inline script(s) the CSP would block:`);
    for (const v of violations) console.error("  " + v);
    console.error("  Add the hash to lib/csp/shell-hashes.ts (after checking the script is Next/React's own).");
    process.exit(1);
  }
  const stale = SHELL_INLINE_SCRIPT_HASHES.filter((h) => !seen.has(h));
  if (stale.length > 0) {
    console.warn(`! shell-csp guard: ${stale.length} listed hash(es) no longer appear in any shell — prune lib/csp/shell-hashes.ts: ${stale.join(", ")}`);
  }
  console.log(`✓ shell-csp guard: ${shells} shells, every inline script is hash-allowlisted (${seen.size} distinct).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
