/** Build the Cognito Pre Token Generation V3 Lambda deployment zip.
 *
 * Pipeline:
 *   esbuild lib/cognito-pretoken/lambda.ts → dist/lambda/lambda.js
 *   → zip with the file as `lambda.js` at the root
 *
 * Output zip path: `dist/lambda/dante-cognito-pretoken-lambda.zip`.
 * Terraform consumes this via `package_zip_path` on the
 * cognito-pretoken-lambda module.
 *
 * Mirrors `build-sync-lambda.ts` minus the AWS SDK externals — this
 * Lambda only uses Node runtime + aws-lambda types (devDep). */
import { promises as fs } from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import AdmZip from "adm-zip";

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "dist", "lambda-cognito-pretoken");
const OUT_JS = path.join(OUT_DIR, "lambda.js");
const OUT_ZIP = path.join(OUT_DIR, "dante-cognito-pretoken-lambda.zip");

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const started = Date.now();
  await build({
    entryPoints: [path.join(ROOT, "lib/cognito-pretoken/lambda.ts")],
    outfile: OUT_JS,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: false,
    sourcemap: false,
    external: [
      "@aws-sdk/*",
      "aws-sdk",
    ],
    logLevel: "info",
  });
  const buildMs = Date.now() - started;

  // Handler ref is `lambda.handler` — file must zip as `lambda.js`
  // at the archive root.
  const zip = new AdmZip();
  zip.addLocalFile(OUT_JS);
  zip.writeZip(OUT_ZIP);

  const stat = await fs.stat(OUT_ZIP);
  console.log(
    `Built ${path.relative(ROOT, OUT_ZIP)} (${(stat.size / 1024).toFixed(1)} KB) in ${buildMs}ms`,
  );
}

main().catch((err) => {
  console.error("build-cognito-pretoken-lambda failed:", err);
  process.exit(1);
});
