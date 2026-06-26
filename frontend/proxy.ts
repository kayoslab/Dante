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
  // Agent integration: every endpoint under /api/agent/* uses
  // bearer-token auth (Cognito JWT verified by lib/auth/agent-jwt.ts).
  // The proxy here is cookie-aware only; without this prefix the
  // proxy redirects bearer-auth calls to /login because req.auth is
  // null for them, and the route handlers never see the bearer at
  // all. The handlers still call requireAgentSession on every
  // request — defense in depth.
  "/api/agent",
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

type CspResult = {
  requestHeaders: Headers;
  responseHeaders: Headers;
};

/** Build the CSP + nonce for an HTML request and return both the
 * request and response header sets that need it.
 *
 * The crucial bit (and the one easy to get wrong): Next.js extracts
 * the nonce from the `Content-Security-Policy` header on the *request*
 * during render, then attaches it to its bootstrap scripts. Setting
 * CSP only on the response — which feels intuitive — means the
 * browser sees the strict policy but Next never tagged its scripts
 * with the nonce, so the browser blocks the bootstrap, hydration
 * dies, the page renders without client-side JS, dev Fast Refresh
 * stops working, and Tailwind utility-styling appears broken because
 * dev mode injects styles via JS. The forwarded request header is
 * the load-bearing line.
 */
function buildCsp(req: NextRequest): CspResult | null {
  if (!needsCsp(req.nextUrl.pathname)) return null;

  const isDev = process.env.NODE_ENV === "development";
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const directives = [
    "default-src 'self'",
    // `'strict-dynamic'` lets nonced scripts dynamically import more
    // scripts without us having to enumerate hosts. Dev mode needs
    // `'unsafe-eval'` for React's enhanced error-overlay debugger and
    // Turbopack/Webpack HMR.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    // Tailwind utility classes + Recharts inline transforms produce
    // inline `<style>` tags we can't nonce.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // Dev needs a WebSocket back to the Turbopack/Webpack HMR server
    // — `ws://localhost:*` covers it. In prod the app only talks to
    // itself for fetch/XHR.
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // `upgrade-insecure-requests` rewrites every `http://` URL the
    // browser sees to `https://` — perfect in prod (HSTS-enforced),
    // broken in dev (localhost serves over plain HTTP, so CSS, nav,
    // every fetch fails the upgrade). Prod-only.
    ...(isDev ? [] : ["upgrade-insecure-requests"]),
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
  ];
  const csp = directives.join("; ");

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  // Next.js's renderer reads the nonce off the request CSP header.
  requestHeaders.set("Content-Security-Policy", csp);

  const responseHeaders = new Headers();
  responseHeaders.set("Content-Security-Policy", csp);
  responseHeaders.set(
    "Reporting-Endpoints",
    'csp-endpoint="/api/csp-report"',
  );
  responseHeaders.set("x-nonce", nonce);

  return { requestHeaders, responseHeaders };
}

function nextWithCsp(req: NextRequest): NextResponse {
  const csp = buildCsp(req);
  if (!csp) return NextResponse.next();
  const response = NextResponse.next({
    request: { headers: csp.requestHeaders },
  });
  csp.responseHeaders.forEach((value, key) => response.headers.set(key, value));
  return response;
}

function redirectWithCsp(req: NextRequest, url: URL): NextResponse {
  const csp = buildCsp(req);
  const response = NextResponse.redirect(url);
  if (csp) {
    csp.responseHeaders.forEach((value, key) =>
      response.headers.set(key, value),
    );
  }
  return response;
}

export const proxy = auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) return nextWithCsp(req);
  if (req.auth) return nextWithCsp(req);

  // Preserve the original destination so post-login we can route them back.
  const callbackUrl = encodeURIComponent(pathname + search);
  const loginUrl = new URL(`/login?callbackUrl=${callbackUrl}`, req.nextUrl);
  return redirectWithCsp(req, loginUrl);
});

export const config = {
  // Match everything except Next.js internals and static files. /api/* is
  // covered (so route handlers respect auth) — /api/auth/* is allowlisted
  // above so Auth.js's own callbacks still work.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
