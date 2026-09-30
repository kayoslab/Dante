/** Inline scripts that live in the *prerendered* static shells.
 *
 * With Cache Components every page ships a build-time static shell whose
 * `<script>` tags carry no nonce (there is no request at build time). The
 * per-request nonce in `proxy.ts` therefore only covers the streamed
 * dynamic part; the shell's external chunks are allowed by `'self'`, and
 * the shell's inline scripts must be allowed by hash. Today that is a
 * single constant React 19 bootstrap. Keep this list in sync with what
 * `scripts/check-shell-csp.ts` finds after `next build` — that guard fails
 * the Docker build when a Next/React upgrade adds an inline script that
 * isn't listed here, so it can't silently break hydration in prod.
 *
 * Shared by `proxy.ts` (policy) and the post-build guard (verification).
 */
export const SHELL_INLINE_SCRIPT_HASHES: readonly string[] = [
  // `requestAnimationFrame(function(){$RT=performance.now()});`
  // React 19.2 server-timing bootstrap emitted at the top of every shell.
  "sha256-7mu4H06fwDCjmnxxr/xNHyuQC6pLTHr4M2E4jXw5WZs=",
];

/** Shells that may contain unlisted inline scripts. `/_global-error` is a
 * fully static page (no Suspense boundary) so its RSC payload is inlined
 * with build-specific chunk names — it renders as plain HTML under the
 * strict policy, which is acceptable for a fatal-error surface. */
export const SHELL_CSP_EXEMPT = new Set(["_global-error.html"]);
