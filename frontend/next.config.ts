import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** Content-Security-Policy directives.
 *
 *  - `default-src 'self'` — fallback for any directive not explicitly set.
 *  - `script-src` — Next.js inlines small bootstrap scripts on every page;
 *    Recharts/shadcn don't use eval. In dev, turbopack's hot-reload uses
 *    eval, so we open `'unsafe-eval'` there only.
 *  - `style-src 'self' 'unsafe-inline'` — Tailwind utility class injection
 *    + Recharts inline transform styles. Stripping inline styles would
 *    break the charts; the risk is bounded since we have no
 *    `dangerouslySetInnerHTML` of user content (verified by red-team audit).
 *  - `img-src 'self' data: blob:` — chart export, favicon, base64 assets.
 *  - `connect-src 'self'` — Cognito hosted UI is reached via full
 *    navigation, NextAuth token exchange runs server-side.
 *  - `frame-ancestors 'none'` — kills clickjacking on the admin "disable
 *    user" / SDM-grant buttons. This is the highest-value directive here.
 *  - `base-uri 'self'` — prevent injected `<base>` from redirecting paths.
 *  - `form-action 'self'` — sign-in form POSTs to /api/auth/callback/*
 *    (same origin); Cognito hosted UI is a navigation, not a form post. */
function csp(): string {
  const directives = [
    "default-src 'self'",
    isProd
      ? "script-src 'self' 'unsafe-inline'"
      : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ];
  return directives.join("; ");
}

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp() },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // HSTS only in prod — dev runs over HTTP and a max-age=31536000 header
  // received over an HTTPS test session would brick http://localhost.
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains; preload",
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  // `standalone` output produces a self-contained `.next/standalone/`
  // directory with only the files the runtime needs. The Dockerfile
  // copies this and runs `node server.js` — no `next start`, no full
  // node_modules in the final image, ~10x smaller.
  output: "standalone",
  // Opt into the `forbidden()` / `unauthorized()` helpers from
  // `next/navigation`. Without this flag the helpers fall through to
  // the generic error boundary (500), which is why /salary, /settings
  // were surfacing as 500s for non-admin users.
  experimental: {
    authInterrupts: true,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
