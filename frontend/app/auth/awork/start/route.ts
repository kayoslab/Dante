/** Start the interactive awork OAuth (Authorization Code + PKCE) flow.
 *
 * The browser hits this endpoint via the "Authorize awork" button on
 * `/settings/integrations/awork`. We:
 *   1. generate a fresh code_verifier + state pair
 *   2. stash both in a short-lived HTTP-only cookie (survives the OAuth
 *      round-trip because SameSite=Lax)
 *   3. redirect the browser to awork's `/accounts/authorize` endpoint
 *
 * The callback at `/auth/awork/callback` reads the cookie, verifies the
 * state, exchanges the code for tokens.
 *
 * Admin-only. Re-authorization is a one-off, sensitive operation.
 */
import crypto from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { buildAuthorizeUrl } from "@/lib/sync/awork/auth";

export const COOKIE_NAME = "awork_oauth_state";
const COOKIE_TTL_SECONDS = 10 * 60; // generous window for the user to complete the awork screen

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function genPkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(48)); // ~64 chars
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await getSession();
  if (!ctx) {
    return NextResponse.redirect(new URL("/login", req.nextUrl));
  }
  if (ctx.role !== "admin") {
    return NextResponse.json(
      { detail: "Admin only", code: "forbidden" },
      { status: 403 },
    );
  }

  const { verifier, challenge } = genPkcePair();
  const state = b64url(crypto.randomBytes(24));
  // Behind the ALB, `req.nextUrl.origin` reflects the ECS task's internal
  // `http://...:3000` URL (the ALB terminates TLS and forwards plain HTTP),
  // so building the redirect URI from it produces an `http://` value that
  // awork rejects because it doesn't match the registered `https://` one.
  // NEXTAUTH_URL is the canonical public origin and matches both Cognito's
  // callback registration and awork's. Fall back to the request origin in
  // dev where NEXTAUTH_URL may be unset.
  const publicOrigin = process.env.NEXTAUTH_URL ?? req.nextUrl.origin;
  const redirect_uri = new URL("/auth/awork/callback", publicOrigin).toString();

  const authorizeUrl = await buildAuthorizeUrl({
    redirect_uri,
    code_challenge: challenge,
    state,
  });

  await audit(ctx, {
    action: "awork_oauth_start",
    target_type: "integration",
    target_id: "awork",
  });

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(COOKIE_NAME, JSON.stringify({ verifier, state, redirect_uri }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/auth/awork",
    maxAge: COOKIE_TTL_SECONDS,
  });
  return res;
}
