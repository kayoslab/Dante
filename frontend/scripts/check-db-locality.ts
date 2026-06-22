// Guard: database calls must live in lib/db/ only.
//
// Invariant: every db.execute / db.select / db.insert / db.update /
// db.delete / db.transaction call lives inside lib/db/. API routes,
// Server Actions, and pages call query functions from
// lib/db/queries/*; they do not touch the connection directly.
//
// Enforces the AGENTS.md "Wire shape" convention. Also flags raw
// imports of the connection module or the schema module outside
// lib/db/ — those are the upstream signal that someone is about to
// write inline SQL.
//
// Run via `npm run check:db-locality` (wired into `npm run check`).
import { promises as fs } from "node:fs";
import path from "node:path";

const FRONTEND_ROOT = path.resolve(".");

// Directories scanned for violations. Everything else is implicitly
// allowed (e.g. tests, scripts, node_modules).
const SCAN_DIRS = [
  path.join(FRONTEND_ROOT, "app"),
  path.join(FRONTEND_ROOT, "lib/actions"),
  path.join(FRONTEND_ROOT, "lib/api"),
  path.join(FRONTEND_ROOT, "lib/auth"),
  // `lib/sync` is the data-ingest tier — sync code legitimately reads
  // and writes through Drizzle for the typed upsert path. Its own
  // `check-awork-readonly` covers the write surface from a different
  // angle; we don't enforce locality there.
];

// Files explicitly allowed to touch the DB client (e.g. the audit
// helper, which is a leaf used everywhere — moving it into lib/db
// would itself violate locality in the other direction). Keep this
// list small; every entry is a deliberate carve-out.
const ALLOW_LIST = new Set<string>([
  "lib/auth/audit.ts", // writes app_audit_log; cross-cutting infra
  "lib/auth/users.ts", // findOrCreateAppUser — auth-bootstrap, runs before lib/db is initialised
  "lib/auth/session.ts", // isUserDisabled cache — auth-fastpath read
]);

// Patterns that count as "talking to the DB". Substring + tagged-
// template matches catch both `db.execute(sql\`...\`)` and the
// builder forms `db.select({...}).from(...)`.
const DB_PATTERNS: { re: RegExp; label: string }[] = [
  // `db.execute(` / `db.select(` / `db.insert(` / etc.
  { re: /\bdb\s*\.\s*(execute|select|insert|update|delete|transaction)\s*\(/, label: "db.<verb>(" },
  // Multi-line chained form: `db\n.insert(...)`.
  { re: /\bawait\s+db\s*$/, label: "await db (chained)" },
  // Direct import from the connection module — even without a call
  // site, the import means a violation is about to land.
  { re: /from\s+["']@\/lib\/db\/client["']/, label: 'import "@/lib/db/client"' },
  // Schema import outside lib/db means raw SQL is being authored.
  { re: /from\s+["']@\/lib\/db\/schema["']/, label: 'import "@/lib/db/schema"' },
];

async function walk(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Skip generated / vendor dirs.
      if (e.name === "node_modules" || e.name === ".next" || e.name === "dist") {
        continue;
      }
      out.push(...(await walk(p)));
    } else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

type Hit = { file: string; line: number; text: string; pattern: string };

async function scan(): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const dir of SCAN_DIRS) {
    const files = await walk(dir);
    for (const file of files) {
      const rel = path.relative(FRONTEND_ROOT, file);
      if (ALLOW_LIST.has(rel)) continue;
      const body = await fs.readFile(file, "utf-8");
      const lines = body.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Strip line comments + single-line block comments so
        // explanatory prose mentioning `db.execute` doesn't trigger.
        const stripped = line
          .replace(/\/\/.*$/, "")
          .replace(/\/\*.*?\*\//g, "");
        for (const { re, label } of DB_PATTERNS) {
          if (re.test(stripped)) {
            hits.push({
              file: rel,
              line: i + 1,
              text: line.trim(),
              pattern: label,
            });
          }
        }
      }
    }
  }
  return hits;
}

async function main(): Promise<void> {
  const hits = await scan();
  if (hits.length === 0) {
    console.log(
      "✓ db-locality guard: no db.* calls or @/lib/db/{client,schema} imports outside lib/db/.",
    );
    return;
  }
  console.error(
    "✗ db-locality guard FAILED — database access detected outside lib/db/:\n",
  );
  for (const h of hits) {
    console.error(`  ${h.file}:${h.line}  matched ${h.pattern}`);
    console.error(`    ${h.text}`);
  }
  console.error(
    "\nDB code must live in lib/db/queries/*. API routes, Server Actions,",
  );
  console.error(
    "and pages call named query functions; they don't open db.execute /",
  );
  console.error("db.select directly. See AGENTS.md → 'DB locality'.");
  console.error(
    "\nIf a leaf helper genuinely needs to bypass the rule (e.g. the audit",
  );
  console.error(
    "writer), add it to ALLOW_LIST in scripts/check-db-locality.ts with a",
  );
  console.error("one-line comment explaining why.");
  process.exit(1);
}

main().catch((err) => {
  console.error("check-db-locality failed to run:", err);
  process.exit(2);
});
