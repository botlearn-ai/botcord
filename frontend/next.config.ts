import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  env: {
    SHOW_MESSAGE_STATUS: process.env.SHOW_MESSAGE_STATUS ?? process.env.NEXT_PUBLIC_SHOW_MESSAGE_STATUS ?? "true",
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  transpilePackages: ["three", "@react-three/fiber", "@react-three/drei"],
};

export default nextConfig;
