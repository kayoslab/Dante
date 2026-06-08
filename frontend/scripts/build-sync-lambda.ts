/** Build the sync Lambda deployment zip.
 *
 * Pipeline:
 *   esbuild lib/sync/lambda.ts → dist/lambda/lambda.js (bundled, single file)
 *   → zip with the file as `lambda.js` at the root of the archive
 *
 * Output zip path: `dist/lambda/dante-sync-lambda.zip`. Terraform consumes
 * this via the `package_zip_path` variable on the sync-lambda module.
 *
 * What's external (not bundled): pg's native bindings — `pg-native` is
 * commented out by default; the standard pg client uses pure JS sockets
 * and bundles fine. AWS SDK v3 is in the runtime, so we mark it external
 * too (saves a few MB).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import AdmZip from "adm-zip";

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "lambda");
const OUT_JS = path.join(OUT_DIR, "lambda.js");
const OUT_ZIP = path.join(OUT_DIR, "dante-sync-lambda.zip");

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const started = Date.now();
  await build({
    entryPoints: [path.join(ROOT, "lib/sync/lambda.ts")],
    outfile: OUT_JS,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false, // CloudWatch stack traces stay readable; size delta is small
    sourcemap: false,
    external: [
      // AWS SDK v3 is pre-installed in the Node 22 runtime.
      "@aws-sdk/*",
      "aws-sdk",
      // pg-native — optional perf path. Not used.
      "pg-native",
    ],
    logLevel: "info",
  });
  const buildMs = Date.now() - started;

  // Zip the single bundled file. Lambda expects the handler entry to be
  // resolvable from `<archive_root>/<file>.<exported_name>` — our handler
  // ref is `lambda.handler`, so the zipped path must be `lambda.js`.
  const zip = new AdmZip();
  zip.addLocalFile(OUT_JS);
  zip.writeZip(OUT_ZIP);

  const stat = await fs.stat(OUT_ZIP);
  console.log(
    `Built ${path.relative(ROOT, OUT_ZIP)} (${(stat.size / 1024 / 1024).toFixed(2)} MB) in ${buildMs}ms`,
  );
}

main().catch((err) => {
  console.error("build-sync-lambda failed:", err);
  process.exit(1);
});
