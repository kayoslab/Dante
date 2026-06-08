/** Guard: the awork integration must stay read-only.
 *
 * Invariant: the only place in `lib/sync/awork/**` that issues a POST is
 * `auth.ts` (to awork's OAuth token endpoint, for refresh + future
 * authorization-code exchange). Anything else implies someone added a
 * write path against awork, which the project explicitly forbids.
 *
 * Replaces the lost Python AST test (`httpx.post` was gated to
 * `awork_auth._post_to_token_endpoint`). Pure grep is sufficient — the
 * surface is small and the false-positive risk is low.
 *
 * Run via `npm run check:awork-readonly` (also wired into `npm run check`).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const AWORK_DIR = path.resolve("lib/sync/awork");
const ALLOWED_POST_FILES = new Set(["auth.ts"]);

// What counts as "issuing a POST". Matched as substrings — these are the
// recognizable shapes that show up in TS HTTP clients. Add patterns here
// if a new HTTP client surfaces.
const POST_PATTERNS: RegExp[] = [
  /method\s*:\s*["']POST["']/,
  /\.post\s*\(/,
  /axios\.post/,
  /undici\.request[^)]*method\s*:\s*["']POST["']/,
];

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

type Hit = { file: string; line: number; text: string; pattern: string };

async function scan(): Promise<Hit[]> {
  const files = await walk(AWORK_DIR);
  const hits: Hit[] = [];
  for (const file of files) {
    const rel = path.relative(AWORK_DIR, file);
    if (ALLOWED_POST_FILES.has(rel)) continue;
    const body = await fs.readFile(file, "utf-8");
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Strip line comments + trailing block comments so commentary mentioning
      // "POST" doesn't trigger. (Block comments spanning lines are rare here.)
      const stripped = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
      for (const re of POST_PATTERNS) {
        if (re.test(stripped)) {
          hits.push({
            file: path.relative(process.cwd(), file),
            line: i + 1,
            text: line.trim(),
            pattern: re.source,
          });
        }
      }
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const hits = await scan();
  if (hits.length === 0) {
    console.log("✓ awork read-only guard: no POST sites outside lib/sync/awork/auth.ts");
    return;
  }
  console.error("✗ awork read-only guard FAILED — POST detected outside auth.ts:\n");
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  matched /${h.pattern}/`);
    console.error(`    ${h.text}`);
  }
  console.error(
    "\nThe awork integration must stay read-only. If you genuinely need a new write path,",
  );
  console.error(
    "discuss with the owner first and update ALLOWED_POST_FILES in this script along with",
  );
  console.error("a comment explaining why.");
  process.exit(1);
}

main().catch((err) => {
  console.error("check-awork-readonly failed to run:", err);
  process.exit(2);
});
