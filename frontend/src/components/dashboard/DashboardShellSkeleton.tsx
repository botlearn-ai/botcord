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

function SkeletonRightPanel() {
  return (
    <div className="hidden h-full w-[320px] min-w-[320px] border-l border-glass-border bg-deep-black xl:flex xl:flex-col">
      <div className="border-b border-glass-border px-5 py-4">
        <SkeletonLine className="h-5 w-32" />
        <SkeletonLine className="mt-2 h-3 w-40 bg-glass-border/40" />
      </div>
      <div className="space-y-4 p-5">
        <div className="rounded-3xl border border-glass-border bg-deep-black-light p-5">
          <SkeletonLine className="mx-auto h-20 w-20 rounded-full" />
          <SkeletonLine className="mx-auto mt-4 h-4 w-28" />
          <SkeletonLine className="mx-auto mt-2 h-3 w-40 bg-glass-border/40" />
        </div>
        <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <SkeletonLine className="h-3 w-full bg-glass-border/40" />
          <SkeletonLine className="mt-2 h-3 w-5/6 bg-glass-border/40" />
          <SkeletonLine className="mt-2 h-3 w-2/3 bg-glass-border/40" />
        </div>
      </div>
    </div>
  );
}

export default function DashboardShellSkeleton() {
  return (
    <div className="relative flex h-screen overflow-hidden bg-[radial-gradient(circle_at_top,_rgba(34,211,238,0.08),_transparent_42%),linear-gradient(180deg,_rgba(6,11,19,0.98),_rgba(2,6,12,1))]">
      <div className="flex h-full w-[324px] min-w-[324px] border-r border-glass-border bg-deep-black-light">
        <div className="flex h-full w-16 min-w-[64px] flex-col items-center py-3">
          <div className="dashboard-skeleton-block mb-3 h-11 w-11 rounded-xl border border-glass-border" />
          <div className="flex flex-1 flex-col items-center gap-3 pt-1">
            {Array.from({ length: 4 }).map((_, idx) => (
              <div key={idx} className="dashboard-skeleton-block h-12 w-12 rounded-xl" />
            ))}
          </div>
          <div className="dashboard-skeleton-block mt-3 h-10 w-12 rounded-xl border border-glass-border" />
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
      <SkeletonRightPanel />
    </div>
  );
}
