/** Defensive validators for redirect targets.
 *
 * `safeCallback` rejects anything that isn't a same-origin relative path,
 * including the classic `//evil.com` protocol-relative trick and any
 * absolute URL the attacker controls. Apply at every place the app
 * accepts a `callbackUrl` / `redirectTo` from user input — the login
 * page, the LoginForm's `signIn` call, any future "return to" handler.
 *
 * Threat: `?callbackUrl=https://evil.com` on a phishing link sends an
 * already-signed-in victim to an attacker page that mirrors the Dante
 * UI. Validating here means an attacker-supplied URL collapses to "/"
 * silently — never an external redirect.
 */
export function safeCallback(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) return "/";
  // Protocol-relative `//evil.com/...` — browsers treat as absolute.
  if (input.startsWith("//")) return "/";
  // Absolute URL — never trust the host, even our own (host header
  // can be spoofed and Next's Server Action redirects honor it).
  if (!input.startsWith("/")) return "/";
  // Defense in depth against newline/CRLF injection into the Location
  // header (Next normalizes today, but cheap to enforce explicitly).
  if (/[\r\n]/.test(input)) return "/";
  return input;
}
