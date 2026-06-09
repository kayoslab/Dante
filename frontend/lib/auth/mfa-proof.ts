/** Server-only proof of MFA verification.
 *
 * The threat (CVE-style: C-001 in the pre-launch pen test): Auth.js v5's
 * `useSession().update(data)` is client-callable. The JWT callback runs
 * with `trigger === "update"` and the client-supplied `session` payload.
 * Honoring `mfa_verified: true` from that payload directly is a one-line
 * MFA bypass from the browser console.
 *
 * Defense: the verify Server Action computes an HMAC over
 * `${user_id}:${time_window}` keyed with `AUTH_SECRET`. The JWT callback
 * accepts `mfa_verified: true` only when accompanied by a valid HMAC
 * for the current or previous time window. The client can't compute
 * the HMAC without the secret, so the update is effectively
 * server-mintable only.
 *
 * Time window: a fixed 5-minute slot, plus a 1-window grace for clock
 * skew or slow clients. Captures replay narrowly — even if an attacker
 * sees the proof in transit, it expires within ~10 minutes — without
 * forcing a round-trip to the DB on every update.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_MS = 5 * 60 * 1000;

function authSecret(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    throw new Error("AUTH_SECRET is not set — refusing to compute MFA proof.");
  }
  return s;
}

function currentWindow(now: number = Date.now()): number {
  return Math.floor(now / WINDOW_MS);
}

function compute(user_id: string, window: number): string {
  return createHmac("sha256", authSecret())
    .update(`mfa-verify:${user_id}:${window}`)
    .digest("hex");
}

/** Mint a proof. Call from a Server Action AFTER the TOTP code has been
 * verified server-side. */
export function mintMfaProof(user_id: string): string {
  return compute(user_id, currentWindow());
}

/** Validate a proof. Accept the current window plus one previous window
 * (covers clock skew and slow client round-trips). Constant-time compare. */
export function verifyMfaProof(user_id: string, proof: unknown): boolean {
  if (typeof proof !== "string" || proof.length !== 64) return false;
  const proofBuf = Buffer.from(proof, "hex");
  if (proofBuf.length !== 32) return false;
  const w = currentWindow();
  for (const candidate of [w, w - 1]) {
    const expected = Buffer.from(compute(user_id, candidate), "hex");
    if (expected.length === proofBuf.length && timingSafeEqual(expected, proofBuf)) {
      return true;
    }
  }
  return false;
}
