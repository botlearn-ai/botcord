"use client";

/**
 * [INPUT]: 依赖 dashboard 视觉 token、当前 /chats 路径与 Tailwind 原子类提供骨架外观
 * [OUTPUT]: 对外提供 DashboardShellSkeleton 组件，按目标 tab 渲染 /chats 整体应用级骨架屏
 * [POS]: dashboard 顶层加载壳，统一覆盖路由进入与鉴权等待，避免局部 spinner 带来的视觉抖动
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";
import DashboardTabSkeleton, { SidebarListSkeleton } from "./DashboardTabSkeleton";
import { Activity, Bot, Home, LogIn, MessageSquare, Search, UserRound, Wallet } from "lucide-react";
import { usePathname } from "next/navigation";

type ShellSkeletonVariant = "home" | "messages" | "bots" | "contacts" | "explore" | "wallet" | "activity";

function SkeletonLine({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
}

export function getShellSkeletonVariantFromPathname(pathname: string | null): ShellSkeletonVariant {
  const parts = (pathname || "/chats").split("/").filter(Boolean);
  const tab = parts[1];
  if (tab === "dm" || tab === "rooms" || tab === "user-chat") return "messages";
  if (
    tab === "messages"
    || tab === "contacts"
    || tab === "explore"
    || tab === "wallet"
    || tab === "activity"
    || tab === "bots"
  ) {
    return tab;
  }
  return "home";
}

function SkeletonRoomList() {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: 7 }).map((_, idx) => (
        <div key={idx} className="rounded-lg border border-glass-border bg-deep-black-light p-3">
          <SkeletonLine className="h-3 w-2/3" />
          <SkeletonLine className="mt-2 h-2.5 w-1/2 bg-glass-border/40" />
        </div>
      ))}
    </div>
  );
}

function SecondaryPanelSkeleton({ variant }: { variant: ShellSkeletonVariant }) {
  if (variant === "messages") {
    return (
      <div className="flex h-full w-[200px] shrink-0 flex-col border-r border-glass-border bg-deep-black/50">
        <div className="flex h-14 items-center justify-between border-b border-glass-border px-3">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">分组</span>
          <SkeletonLine className="h-3.5 w-3.5 bg-glass-border/50" />
        </div>
        <div className="flex-1 py-2">
          <div className="px-3 py-2">
            <SkeletonLine className="h-3 w-28" />
            <SkeletonLine className="mt-2 h-2.5 w-20 bg-glass-border/40" />
          </div>
          {Array.from({ length: 5 }).map((_, idx) => (
            <div key={`self-${idx}`} className="flex items-center gap-2 py-1.5 pl-[28px] pr-3">
              <SkeletonLine className="h-3.5 w-3.5 bg-glass-border/45" />
              <SkeletonLine className="h-3 w-20 bg-glass-border/45" />
              <SkeletonLine className="ml-auto h-4 w-6 rounded-full bg-glass-border/40" />
            </div>
          ))}
          <div className="my-2 border-t border-glass-border/40" />
          <div className="px-3 py-2">
            <SkeletonLine className="h-3 w-20" />
            <SkeletonLine className="mt-2 h-2.5 w-28 bg-glass-border/40" />
          </div>
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={`bots-${idx}`} className="flex items-center gap-2 py-1.5 pl-[28px] pr-3">
              <SkeletonLine className="h-3.5 w-3.5 bg-glass-border/45" />
              <SkeletonLine className="h-3 w-24 bg-glass-border/45" />
              <SkeletonLine className="ml-auto h-4 w-6 rounded-full bg-glass-border/40" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (variant !== "contacts" && variant !== "activity") return null;

  return (
    <div className="flex h-full w-[280px] shrink-0 flex-col border-r border-glass-border bg-deep-black-light">
      <div className="flex h-14 items-center justify-between border-b border-glass-border px-4">
        <SkeletonLine className="h-4 w-24" />
        <SkeletonLine className="h-8 w-8 rounded-lg bg-glass-border/40" />
      </div>
      <SidebarListSkeleton rows={variant === "contacts" ? 9 : 7} withAvatar={variant === "contacts"} />
    </div>
  );
}

export default function DashboardShellSkeleton({ variant: variantProp }: { variant?: ShellSkeletonVariant }) {
  const pathname = usePathname();
  const variant = variantProp ?? getShellSkeletonVariantFromPathname(pathname);
  const primaryNav = [
    { key: "home", label: "Home", icon: <Home className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "messages", label: "Messages", icon: <MessageSquare className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "bots", label: "My Bots", icon: <Bot className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "contacts", label: "Contacts", icon: <UserRound className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "explore", label: "Explore", icon: <Search className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "wallet", label: "Wallet", icon: <Wallet className="h-5 w-5" strokeWidth={1.5} /> },
    { key: "activity", label: "Activity", icon: <Activity className="h-5 w-5" strokeWidth={1.5} /> },
  ] as const;

  return (
    <div className="relative flex h-screen overflow-hidden bg-deep-black">
      <div className="flex h-full bg-deep-black-light">
        <div className="flex h-full w-16 min-w-[64px] flex-col items-center border-r border-glass-border bg-deep-black py-3">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light">
            <img src="/logo.svg" alt="BotCord" className="h-6 w-6 opacity-80" />
          </div>
          <div className="flex flex-1 flex-col items-center gap-1 pt-1">
            {primaryNav.map((item) => (
              <div
                key={item.key}
                className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
                  item.key === variant
                    ? "bg-neon-cyan/15 text-neon-cyan"
                    : "text-text-secondary"
                }`}
              >
                {item.icon}
                <span className="mt-0.5 max-w-full truncate text-[9px] font-medium leading-none">{item.label}</span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex h-10 w-12 items-center justify-center rounded-xl border border-glass-border bg-deep-black/50 text-text-secondary">
            <LogIn className="h-5 w-5" strokeWidth={1.5} />
          </div>
        </div>

        <SecondaryPanelSkeleton variant={variant} />

        {variant === "messages" ? (
          <div className="flex h-full min-w-0 flex-1 flex-col border-r border-glass-border">
          <div className="flex h-14 items-center justify-between border-b border-glass-border px-3">
            <span className="text-sm font-semibold text-text-primary">Messages</span>
            <div className="flex items-center gap-3 text-text-secondary">
              <Search className="h-4 w-4" />
              <UserRound className="h-4 w-4" />
              <MessageSquare className="h-4 w-4" />
            </div>
          </div>
          <SkeletonRoomList />
          </div>
        ) : null}
      </div>

      {variant === "messages" ? (
        <DashboardMessagePaneSkeleton />
      ) : (
        <div className="min-w-0 flex-1">
          <DashboardTabSkeleton variant={variant} />
        </div>
      )}
    </div>
  );
}
