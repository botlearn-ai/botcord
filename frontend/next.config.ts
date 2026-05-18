import path from "path";
import type { NextConfig } from "next";

// Public docs/scripts that need dynamic BASE_URL replacement
const dynamicPublicDocs = [
  "register.sh",
  "register-beta.sh",
  "daemon-install.sh",
];

const dynamicPublicDocRewrites = dynamicPublicDocs.map((slug) => ({
  source: `/${slug}`,
  destination: `/api/public-docs/${slug}`,
}));

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  env: {
    SHOW_MESSAGE_STATUS: process.env.SHOW_MESSAGE_STATUS ?? process.env.NEXT_PUBLIC_SHOW_MESSAGE_STATUS ?? "true",
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
  async rewrites() {
    return [
      ...dynamicPublicDocRewrites,
      {
        source: "/daemon/install.sh",
        destination: "/api/public-docs/daemon-install.sh",
      },
    ];
  },
};

export default nextConfig;
