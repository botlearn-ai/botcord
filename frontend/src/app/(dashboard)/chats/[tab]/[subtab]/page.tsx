"use client";

/**
 * [INPUT]: 依赖上层 chats/layout.tsx 持久挂载 DashboardApp
 * [OUTPUT]: 对外提供 /chats/[tab]/[subtab] 路由占位页
 * [POS]: 二级 tab 深链占位，保证地址变化不引发 dashboard remount
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export default function ChatsSubtabPage() {
  return null;
}
