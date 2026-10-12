import path from "path";
import type { NextConfig } from "next";
import { LEGACY_AGENT_AVATAR_MAP } from "./src/lib/agent-avatar-legacy";

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
  // Pixel avatars were replaced by the VI v1.0 SVG set (migration 012). Keep old
  // URLs (stored values not yet migrated, caches, shared links) resolving.
  async redirects() {
    return Object.entries(LEGACY_AGENT_AVATAR_MAP).flatMap(([n, destination]) => [
      { source: `/agent-avatars/${n}.png`, destination, permanent: true },
      { source: `/avatars/bots/${n}.png`, destination, permanent: true },
    ]);
  },
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
