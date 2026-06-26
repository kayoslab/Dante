/** Build the sync Lambda deployment zip.
 *
 * Pipeline:
 *   esbuild lib/sync/lambda.ts → dist/lambda/lambda.js (bundled, single file)
 *   download RDS Global CA bundle → dist/lambda/rds-global-bundle.pem
 *   → zip both with `lambda.js` + `rds-global-bundle.pem` at the archive root
 *
 * The PEM has to ride along because IAM-auth connections use it as
 * `ssl.ca` for `verify-full` chain validation. The container build
 * bakes it at `/app/rds-global-bundle.pem`; in Lambda, code lives at
 * `/var/task/` instead. The Terraform module pins
 * `DANTE_RDS_CA_BUNDLE_PATH=/var/task/rds-global-bundle.pem` so the
 * runtime reads it from there.
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
const OUT_PEM = path.join(OUT_DIR, "rds-global-bundle.pem");
const OUT_ZIP = path.join(OUT_DIR, "dante-sync-lambda.zip");
const RDS_BUNDLE_URL =
  "https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem";

async function downloadRdsBundle(): Promise<void> {
  const res = await fetch(RDS_BUNDLE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to download RDS Global CA bundle: HTTP ${res.status}`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(OUT_PEM, buf);
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const started = Date.now();
  await Promise.all([
    build({
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
    }),
    downloadRdsBundle(),
  ]);
  const buildMs = Date.now() - started;

  // Zip the bundled JS + the RDS Global CA. Lambda expects the
  // handler entry to be resolvable from
  // `<archive_root>/<file>.<exported_name>` — our handler ref is
  // `lambda.handler`, so the zipped path must be `lambda.js`. The PEM
  // sits next to it at the archive root.
  const zip = new AdmZip();
  zip.addLocalFile(OUT_JS);
  zip.addLocalFile(OUT_PEM);
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
