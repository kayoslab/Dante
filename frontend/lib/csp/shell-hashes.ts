/** Inline scripts that live in the *prerendered* static shells.
 *
 * With Cache Components every page ships a build-time static shell whose
 * `<script>` tags carry no nonce (there is no request at build time). The
 * per-request nonce in `proxy.ts` therefore only covers the streamed
 * dynamic part; the shell's external chunks are allowed by `'self'`, and
 * the shell's inline scripts must be allowed by hash.
 *
 * Two kinds of shell scripts:
 *   - Constant ones (React's bootstrap) are listed here by hash.
 *   - Turbopack's runtime bootstrap (Next 16.4+) names the build's chunk
 *     files, so its hash changes from build to build. `scripts/check-shell-csp.ts`
 *     runs after `next build`, accepts only scripts that match
 *     `TURBOPACK_BOOTSTRAP` exactly, and writes their hashes to
 *     `BUILD_HASHES_FILE`; `proxy.ts` reads that file at runtime.
 * Any other inline script fails the Docker build, so a Next/React upgrade
 * can't silently break hydration in prod.
 *
 * Shared by `proxy.ts` (policy) and the post-build guard (verification).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const SHELL_INLINE_SCRIPT_HASHES: readonly string[] = [
  // `requestAnimationFrame(function(){$RT=performance.now()});`
  // React 19.2 server-timing bootstrap emitted at the top of every shell.
  "sha256-7mu4H06fwDCjmnxxr/xNHyuQC6pLTHr4M2E4jXw5WZs=",
];

/** Turbopack's runtime bootstrap, exactly: registers the page's chunk
 * files and runtime module ids, nothing else. Anchored and limited to
 * `static/chunks/*.js` paths and numeric ids so no other code can match. */
export const TURBOPACK_BOOTSTRAP =
  /^\(globalThis\["TURBOPACK"\] \|\| \(globalThis\["TURBOPACK"\] = \[\]\)\)\.push\(\{"otherChunks":\[(?:"static\/chunks\/[A-Za-z0-9_.-]+\.js"(?:,"static\/chunks\/[A-Za-z0-9_.-]+\.js")*)?\],"runtimeModuleIds":\[(?:\d+(?:,\d+)*)?\]\}\);$/;

/** Written by the post-build guard, read by `proxy.ts`. Relative to the
 * server's working directory (`frontend/` locally, `/app` in the image). */
export const BUILD_HASHES_FILE = path.join(".next", "shell-csp-hashes.json");

let buildHashes: readonly string[] | undefined;

/** Constant hashes plus this build's Turbopack bootstrap hashes. A missing
 * file (dev, or a build without the guard) yields the constants only. */
export function shellScriptHashes(): readonly string[] {
  if (buildHashes === undefined) {
    let fromBuild: string[] = [];
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(path.join(process.cwd(), BUILD_HASHES_FILE), "utf-8"),
      );
      if (Array.isArray(parsed)) {
        fromBuild = parsed.filter(
          (h): h is string => typeof h === "string" && /^sha256-[A-Za-z0-9+/]+=*$/.test(h),
        );
      }
    } catch {
      // No build file: constants only.
    }
    buildHashes = [...SHELL_INLINE_SCRIPT_HASHES, ...fromBuild];
  }
  return buildHashes;
}

/** Shells that may contain unlisted inline scripts. `/_global-error` is a
 * fully static page (no Suspense boundary) so its RSC payload is inlined
 * with build-specific chunk names — it renders as plain HTML under the
 * strict policy, which is acceptable for a fatal-error surface. */
export const SHELL_CSP_EXEMPT = new Set(["_global-error.html"]);
