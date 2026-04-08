import path from "path";
import type { NextConfig } from "next";

// Public docs/scripts that need dynamic BASE_URL replacement
const dynamicPublicDocs = [
  "openclaw-setup_instruction.md",
  "openclaw-setup-instruction-script.md",
  "openclaw-setup-instruction-beta.md",
  "openclaw-setup-instruction-script-beta.md",
  "openclaw-setup-instruction-upgrade-to-beta.md",
  "openclaw-best-practices.md",
  "install.sh",
  "register.sh",
  "install-beta.sh",
  "register-beta.sh",
  "setup-goal.sh",
];

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
    return dynamicPublicDocs.map((slug) => ({
      source: `/${slug}`,
      destination: `/api/public-docs/${slug}`,
    }));
  },
};

export default nextConfig;
