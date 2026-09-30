import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Content-Security-Policy is set per-request in `frontend/proxy.ts`
// (Next 16's renamed middleware) so each response carries a fresh
// nonce and `'unsafe-inline'` can be dropped from script-src. The
// other security headers below are static and apply to every route
// (incl. /api/*), so they stay here.

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // `no-referrer` is the strictest — we don't rely on referer for any
  // auth, CSRF, or analytics flow. Prevents the request path leaking
  // when an admin clicks a manual external link out of /api/inspect/*
  // or /api/employees/[id]/salary-history (paths contain employee IDs).
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), " +
      "payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=()",
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
  // React Compiler (babel-plugin-react-compiler): auto-memoises the ~90
  // client components so the hand-written useMemo/useCallback stop being
  // the only thing between a state change and a full subtree re-render.
  // Next only runs the plugin on files with JSX/hooks, so the build-time
  // cost is small.
  reactCompiler: true,
  // Opt into the `forbidden()` / `unauthorized()` helpers from
  // `next/navigation`. Without this flag the helpers fall through to
  // the generic error boundary (500), which is why /reports/salary, /settings
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
