/**
 * [INPUT]: 依赖 DesignGallery 客户端组件
 * [OUTPUT]: /design 组件预览页（VI v1.0 组件库全集），生产环境 404
 * [POS]: 开发与预览环境的组件目录；规范见 docs/brand/botcord-vi/COMPONENTS.md
 * [PROTOCOL]: 新增或修改 components/ui 组件时，同步在 DesignGallery 里补示例
 */

import { notFound } from "next/navigation";
import type { Metadata } from "next";
import DesignGallery from "./DesignGallery";

export const metadata: Metadata = {
  title: "BotCord UI · Components",
  robots: { index: false, follow: false },
};

export default function DesignPage() {
  // Internal reference page: available locally and on Vercel previews only.
  if (process.env.NODE_ENV !== "development" && process.env.VERCEL_ENV !== "preview") notFound();
  return <DesignGallery />;
}
