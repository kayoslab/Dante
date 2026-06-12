import type { NextConfig } from "next";

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
};

export default nextConfig;
