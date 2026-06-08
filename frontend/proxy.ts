/** Route gate.
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
 * What's intentionally NOT here:
 *   - Role-based authorization. The four-layer defense puts that at the
 *     page/action level via `requireSession({ minRole })`. The Proxy
 *     can't read Server Component context cleanly, so it's limited to
 *     "are you signed in at all."
 *   - Audit logging. Same reason — Proxy doesn't have the rich context
 *     (target ID, action name) that pages/actions do.
 */
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";

const PUBLIC_PATHS = ["/login"];

const PUBLIC_PREFIXES = [
  "/api/auth", // Auth.js callbacks, sign-in/out, CSRF
  "/_next", // Next.js static assets
  "/favicon", // /favicon.ico
];

// MFA setup/verify pages live behind authentication but allow
// MFA-pending sessions through. The proxy doesn't differentiate (signed
// in = next()); the gate lives inside the pages themselves via
// `requireSession({ allowMfaPending: true })`. Don't add /auth/mfa here.

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export const proxy = auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();
  if (req.auth) return NextResponse.next();

  // Preserve the original destination so post-login we can route them back.
  const callbackUrl = encodeURIComponent(pathname + search);
  const loginUrl = new URL(`/login?callbackUrl=${callbackUrl}`, req.nextUrl);
  return NextResponse.redirect(loginUrl);
});

export const config = {
  // Match everything except Next.js internals and static files. /api/* is
  // covered (so route handlers respect auth) — /api/auth/* is allowlisted
  // above so Auth.js's own callbacks still work.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
