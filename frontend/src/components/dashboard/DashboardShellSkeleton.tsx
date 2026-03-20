"use client";

/**
 * [INPUT]: 依赖 dashboard 视觉 token 与 Tailwind 原子类提供骨架外观
 * [OUTPUT]: 对外提供 DashboardShellSkeleton 组件，渲染 /chats 整体应用级骨架屏
 * [POS]: dashboard 顶层加载壳，统一覆盖路由进入与鉴权等待，避免局部 spinner 带来的视觉抖动
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

function SkeletonLine({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
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

function SkeletonMessagePane() {
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <SkeletonLine className="h-5 w-40" />
        <SkeletonLine className="mt-2 h-3 w-64 bg-glass-border/40" />
      </div>
      <div className="flex-1 space-y-4 overflow-x-hidden overflow-y-auto px-5 py-5">
        {Array.from({ length: 6 }).map((_, idx) => {
          const isRight = idx % 2 === 1;
          return (
            <div key={idx} className={`flex ${isRight ? "justify-end" : "justify-start"}`}>
              <div className="w-full max-w-[68%] rounded-2xl border border-glass-border bg-deep-black-light p-4">
                <SkeletonLine className="h-3 w-24" />
                <SkeletonLine className="mt-3 h-3 w-56 bg-glass-border/40" />
                <SkeletonLine className="mt-2 h-3 w-40 bg-glass-border/40" />
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-glass-border px-5 py-4">
        <div className="rounded-2xl border border-glass-border bg-deep-black-light px-4 py-3">
          <SkeletonLine className="h-4 w-1/3" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardShellSkeleton() {
  const primaryNav = [
    { key: "messages", active: true },
    { key: "contacts", active: false },
    { key: "explore", active: false },
    { key: "wallet", active: false },
  ] as const;

  const navIcon = (key: (typeof primaryNav)[number]["key"]) => {
    if (key === "messages") {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
        </svg>
      );
    }
    if (key === "contacts") {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" />
        </svg>
      );
    }
    if (key === "explore") {
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607Z" />
        </svg>
      );
    }
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
      </svg>
    );
  };

  return (
    <div className="relative flex h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.08),_transparent_42%),linear-gradient(180deg,_rgba(6,11,19,0.98),_rgba(2,6,12,1))]">
      <div className="flex h-full w-[324px] min-w-[324px] border-r border-glass-border bg-deep-black-light">
        <div className="flex h-full w-16 min-w-[64px] flex-col items-center py-3">
          <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-glass-border bg-deep-black-light">
            <img src="/logo.svg" alt="BotCord" className="h-6 w-6 opacity-80" />
          </div>
          <div className="flex flex-1 flex-col items-center gap-1 pt-1">
            {primaryNav.map((item) => (
              <div
                key={item.key}
                className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-xl transition-all duration-200 ${
                  item.active
                    ? "bg-neon-cyan/15 text-neon-cyan"
                    : "text-text-secondary"
                }`}
              >
                {item.active && (
                  <div className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-neon-cyan" />
                )}
                {navIcon(item.key)}
              </div>
            ))}
          </div>
          <div className="mt-3 flex h-10 w-12 items-center justify-center rounded-xl border border-glass-border bg-deep-black/50 text-text-secondary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0 0 13.5 3h-6a2.25 2.25 0 0 0-2.25 2.25v13.5A2.25 2.25 0 0 0 7.5 21h6a2.25 2.25 0 0 0 2.25-2.25V15m-6 0 3 3m0 0 3-3m-3 3V9" />
            </svg>
          </div>
        </div>

        <div className="flex h-full min-w-0 flex-1 flex-col">
          <div className="border-b border-glass-border px-4 py-3">
            <SkeletonLine className="h-4 w-24" />
            <SkeletonLine className="mt-2 h-3 w-32 bg-glass-border/40" />
          </div>
          <SkeletonRoomList />
        </div>
      </div>

      <SkeletonMessagePane />
    </div>
  );
}
