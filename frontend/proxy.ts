/** Route gate + per-request CSP nonce.
 *
 * Every request to a non-public route passes through here. If there's no
 * session, redirect to /login with the original destination preserved as
 * a callbackUrl query param.
 *
 * Next.js 16 renamed the file convention from `middleware` to `proxy`.
 * Proxy defaults to the Node.js runtime (Edge was the middleware default),
 * which is what lets us safely import `lib/auth` with its pg-backed
 * findOrCreateAppUser callback. Do not set `runtime` explicitly — the
 * Proxy convention rejects it.
 *
 * Also generates a single-use CSP nonce per HTML request, attaches it to
 * the `script-src` directive, and forwards it via the `x-nonce` request
 * header so Next.js's bootstrap scripts and any `<Script>` tags pick it
 * up. Lets us drop `'unsafe-inline'` from script-src entirely — a
 * malicious `<script>` injection no longer executes because it has no
 * matching nonce. JSON-returning /api/* responses don't need CSP, so
 * nonce work is skipped there.
 *
 * What's intentionally NOT here:
 *   - Role-based authorization. The four-layer defense puts that at the
 *     page/action level via `requireSession({ minRole })`. The Proxy
 *     can't read Server Component context cleanly, so it's limited to
 *     "are you signed in at all."
 *   - Audit logging. Same reason — Proxy doesn't have the rich context
 *     (target ID, action name) that pages/actions do.
 */
import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";

const PUBLIC_PATHS = ["/login"];

const PUBLIC_PREFIXES = [
  "/api/auth", // Auth.js callbacks, sign-in/out, CSRF
  "/_next", // Next.js static assets
  "/favicon", // /favicon.ico
];

// MFA enrollment + challenge happen inside Cognito's hosted UI, which
// the user reaches via the redirect to `/api/auth/signin/cognito`
// (already allowlisted under `/api/auth`). No in-app MFA pages exist
// for the proxy to special-case.

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/** Pages that render HTML need CSP + nonce; /api/* returns JSON and
 * has nothing to nonce. Skip the nonce on api paths to keep their
 * responses cacheable and avoid bloating headers. */
function needsCsp(pathname: string): boolean {
  return !pathname.startsWith("/api/");
}

function attachCsp(req: NextRequest, response: NextResponse): NextResponse {
  if (!needsCsp(req.nextUrl.pathname)) return response;

  const isDev = process.env.NODE_ENV === "development";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const directives = [
    "default-src 'self'",
    // `'strict-dynamic'` lets nonced scripts dynamically import more
    // scripts without us having to enumerate hosts. In dev, React debug
    // helpers use `eval` so `'unsafe-eval'` has to be present.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind utility classes + Recharts inline transforms produce
    // inline `<style>` tags we can't nonce. Keep `'unsafe-inline'` for
    // style-src — style-injection XSS is narrow (can't exfiltrate on
    // its own).
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
    // Tell the browser where to POST violation reports. Legacy
    // `report-uri` + modern `report-to` covers both old + new browsers
    // (the modern Reporting API requires the `Report-To` response
    // header set below). Reports land in CloudWatch via
    // `/api/csp-report` so we can spot pentest probes or accidental
    // CSP-blocking of a legitimate dependency.
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
  ];
  const csp = directives.join("; ");

  response.headers.set("Content-Security-Policy", csp);
  // Reporting API endpoint group — pairs with `report-to csp-endpoint`
  // in the CSP directive above.
  response.headers.set(
    "Reporting-Endpoints",
    'csp-endpoint="/api/csp-report"',
  );
  // Forward the nonce so Server Components / <Script> tags can read it
  // via `headers().get('x-nonce')`. Next.js internal bootstrap scripts
  // pick it up automatically from the request header.
  response.headers.set("x-nonce", nonce);
  return response;
}

export const proxy = auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) {
    return attachCsp(req, NextResponse.next());
  }
  if (req.auth) {
    return attachCsp(req, NextResponse.next());
  }

  // Preserve the original destination so post-login we can route them back.
  const callbackUrl = encodeURIComponent(pathname + search);
  const loginUrl = new URL(`/login?callbackUrl=${callbackUrl}`, req.nextUrl);
  return attachCsp(req, NextResponse.redirect(loginUrl));
});

export const config = {
  // Match everything except Next.js internals and static files. /api/* is
  // covered (so route handlers respect auth) — /api/auth/* is allowlisted
  // above so Auth.js's own callbacks still work.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
