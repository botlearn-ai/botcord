"use client";

/**
 * [INPUT]: 依赖上层 chats/layout.tsx 持久挂载 DashboardApp
 * [OUTPUT]: 对外提供 /chats/[tab] 路由占位页
 * [POS]: 一级 tab 路由的空页面，避免切换 tab 时重复创建 dashboard 根实例
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export default function ChatsTabPage() {
  return null;
}
