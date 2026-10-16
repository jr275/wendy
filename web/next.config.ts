import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Development only: the on-screen route badge sat over the chat footer. Compile and runtime errors are still shown.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
