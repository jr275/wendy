import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Development only: the on-screen route badge sat over the chat footer. Compile and runtime errors are still shown.
  devIndicators: false,
  cacheComponents: true,
  // Baseline response headers (no CSP yet: CopilotKit, Spline and inline theme boot need a measured policy, to be added report-only first).
  // Microphone stays allowed for this origin because the voice feature uses it; camera, geolocation and payment are not used.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=(), payment=()" },
        ],
      },
    ];
  },
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
