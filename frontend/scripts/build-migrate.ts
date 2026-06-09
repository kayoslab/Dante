/** Bundle the migration runner into a single Node CommonJS file.
 *
 * The bundle ships inside the app container alongside `server.js`. The
 * entrypoint runs `node migrate.js` before exec'ing `node server.js`,
 * so the DB schema is current before the first request arrives.
 *
 * Externals: pg's native bindings are optional; the standard pure-JS
 * client bundles fine.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { build } from "esbuild";

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "dist", "migrate", "migrate.js");

async function main(): Promise<void> {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  const started = Date.now();
  await build({
    entryPoints: [path.join(ROOT, "scripts/migrate.ts")],
    outfile: OUT,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false,
    sourcemap: false,
    external: ["pg-native"],
    logLevel: "info",
  });
  const stat = await fs.stat(OUT);
  console.log(
    `Built ${path.relative(ROOT, OUT)} (${(stat.size / 1024).toFixed(1)} KB) in ${Date.now() - started}ms`,
  );
}

main().catch((err) => {
  console.error("build-migrate failed:", err);
  process.exit(1);
});
