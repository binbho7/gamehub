import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  distDir: process.env.GAMEHUB_BUILD_OUTPUT_PATH ?? ".next",
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "shared.cloudflare.steamstatic.com" },
    ],
  },
};

export default nextConfig;
