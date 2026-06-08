/** awork OAuth callback.
 *
 * The browser returns here after the user clicks "Allow" on awork's
 * authorize screen. We:
 *   1. read the verifier + expected state out of the start-cookie
 *   2. verify the state matches the `state` query param (CSRF check)
 *   3. exchange `code` for tokens via the token endpoint
 *   4. persist the tokens via `storeAworkTokens` (Secrets Manager or .env)
 *   5. clear the cookie and bounce back to the integration page
 *
 * Errors (missing cookie, state mismatch, token endpoint refusal) all
 * redirect back to the settings page with `?error=<slug>` so the UI can
 * surface a useful message instead of a blank screen.
 */
import { type NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/auth/audit";
import { getSession } from "@/lib/auth/session";
import { log } from "@/lib/logger";
import { exchangeAuthorizationCode } from "@/lib/sync/awork/auth";
import { storeAworkTokens } from "@/lib/sync/credentials";

import { COOKIE_NAME } from "../start/route";

const SETTINGS_URL = "/settings/integrations/awork";

function fail(req: NextRequest, slug: string): NextResponse {
  const url = new URL(SETTINGS_URL, req.nextUrl.origin);
  url.searchParams.set("error", slug);
  const res = NextResponse.redirect(url);
  res.cookies.delete(COOKIE_NAME);
  return res;
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

  // Did the user cancel on awork's screen?
  const errorParam = req.nextUrl.searchParams.get("error");
  if (errorParam) {
    return fail(req, `awork_${errorParam}`);
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return fail(req, "missing_params");
  }

  const cookie = req.cookies.get(COOKIE_NAME);
  if (!cookie) {
    return fail(req, "missing_cookie");
  }
  let payload: { verifier: string; state: string; redirect_uri: string };
  try {
    payload = JSON.parse(cookie.value);
  } catch {
    return fail(req, "bad_cookie");
  }
  if (payload.state !== state) {
    return fail(req, "state_mismatch");
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      code_verifier: payload.verifier,
      redirect_uri: payload.redirect_uri,
    });
    await storeAworkTokens(tokens);
  } catch (err) {
    log.error("awork_oauth_exchange_failed", { err });
    return fail(req, "exchange_failed");
  }

  await audit(ctx, {
    action: "awork_oauth_complete",
    target_type: "integration",
    target_id: "awork",
  });

  const url = new URL(SETTINGS_URL, req.nextUrl.origin);
  url.searchParams.set("ok", "1");
  const res = NextResponse.redirect(url);
  res.cookies.delete(COOKIE_NAME);
  return res;
}
