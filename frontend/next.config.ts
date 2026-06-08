import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `standalone` output produces a self-contained `.next/standalone/`
  // directory with only the files the runtime needs. The Dockerfile
  // copies this and runs `node server.js` — no `next start`, no full
  // node_modules in the final image, ~10x smaller.
  output: "standalone",
};

export default nextConfig;
