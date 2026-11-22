import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    agentUpgrade: "security",
  },
  serverExternalPackages: ["node:sqlite"],
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
