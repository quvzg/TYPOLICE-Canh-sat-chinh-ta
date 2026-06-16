import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "/api/assets/upload": [
      "./next.config.ts",
      "./src/**/*",
      "./storage/**/*",
      "./brand_guidelines/**/*",
    ],
    "/api/**/*": [
      "./next.config.ts",
    ],
  },
};

export default nextConfig;
