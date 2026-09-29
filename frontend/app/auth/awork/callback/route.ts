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
import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";

import { audit } from "@/lib/auth/audit";
import { ForbiddenError, requireSession } from "@/lib/auth/session";
import { log } from "@/lib/logger";
import { exchangeAuthorizationCode } from "@/lib/integrations/providers/awork/auth";
import { storeAworkTokens } from "@/lib/integrations/core/credentials";

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
  // `requireSession` enforces no-session, disabled-user (H-008), and
  // admin role in one call. ForbiddenError → 403 JSON for non-admins.
  let ctx;
  try {
    ctx = await requireSession({ minRole: "admin" });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json(
        { detail: "Admin only", code: "forbidden" },
        { status: 403 },
      );
    }
    throw e;
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
  // Bound the cookie size before parsing — the legitimate payload is
  // ~250 bytes (PKCE verifier ~64 chars + state ~32 chars + a redirect
  // URI). 2 KB is generous; anything bigger is malformed or an attempt
  // to DoS the parser. Was M-006 in the pre-launch pen test.
  if (cookie.value.length > 2048) {
    return fail(req, "bad_cookie");
  }
  let payload: { verifier: string; state: string; redirect_uri: string };
  try {
    payload = JSON.parse(cookie.value);
  } catch {
    return fail(req, "bad_cookie");
  }
  // Constant-time compare on the state to avoid leaking length / prefix
  // information via timing differences. State is not a secret per se,
  // but consistency with crypto hygiene.
  if (
    typeof payload.state !== "string" ||
    payload.state.length !== state.length ||
    !timingSafeEqual(Buffer.from(payload.state), Buffer.from(state))
  ) {
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
    // Don't log the raw error: awork's 4xx response bodies echo the
    // submitted form params (including the PKCE `code_verifier`). The
    // verifier is single-use and bounded, but there's no reason to
    // CloudWatch-archive it. Log only the error class and a short
    // generic message.
    const name = err instanceof Error ? err.name : "Error";
    log.error("awork_oauth_exchange_failed", { name });
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
