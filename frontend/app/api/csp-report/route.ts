/** CSP violation collector.
 *
 * Browsers POST a Content-Security-Policy violation report here whenever
 * they block something the policy didn't allow (an inline script without
 * matching nonce, a fetch to a forbidden origin, etc.). We log the
 * report to CloudWatch — a metric filter / alarm could be wired later
 * to surface spikes (likely indicates a pentest probe or a CSP-blocking
 * a legitimate update we missed).
 *
 * No auth gate: violations can happen for unauthenticated users
 * (e.g. /login page being probed). Rate-limited by WAF's global
 * 2000/5min limit on /api/*; the data we accept is small (a JSON body
 * the browser auto-generates) so DoS amplification is low.
 *
 * Body shape (per the W3C spec):
 *   - Reporting API ("Report-To") sends an array of `Report` objects
 *     with `type: "csp-violation"`.
 *   - Legacy `report-uri` sends `{"csp-report": {...}}`. We accept
 *     both shapes — modern browsers send the Reporting API one when
 *     `report-to` is set in CSP.
 */
import type { NextRequest } from "next/server";

import { log } from "@/lib/logger";

const MAX_BODY_BYTES = 16_384; // generous cap so a hostile client can't ship megabytes

export async function POST(req: NextRequest): Promise<Response> {
  // The browser sets Content-Type to `application/csp-report` (legacy)
  // or `application/reports+json` (Reporting API). We accept whatever
  // it sends — both parse as JSON.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new Response(null, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  log.warn("csp_violation", {
    user_agent: req.headers.get("user-agent"),
    referer: req.headers.get("referer"),
    report: parsed,
  });
  return new Response(null, { status: 204 });
}
