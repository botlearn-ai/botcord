"use client";

/**
 * [INPUT]: 依赖 DashboardApp 提供 /chats 全量工作区，依赖 Next.js layout 保持动态子路由切换时组件不重挂载
 * [OUTPUT]: 对外提供 chats 路由布局；在所有 /chats 子路由下稳定挂载单例 DashboardApp
 * [POS]: dashboard chats 路由的持久壳层，阻止 tab/subtab 切换时整棵应用 remount
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import dynamic from "next/dynamic";
import DashboardShellSkeleton from "@/components/dashboard/DashboardShellSkeleton";

const DashboardApp = dynamic(
  () => import("@/components/dashboard/DashboardApp"),
  {
    ssr: false,
    loading: () => <DashboardShellSkeleton />,
  },
);

export default function ChatsLayout() {
  return <DashboardApp />;
}
