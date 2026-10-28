import type { NextConfig } from "next";

/**
 * Static export: the whole site is HTML + JS reading the chain from the browser. No server, no
 * API route, nothing that could hold a secret - which is the point of keeping web/ separate from
 * server/config.ts.
 */
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  turbopack: { root: __dirname },
};

export default config;
