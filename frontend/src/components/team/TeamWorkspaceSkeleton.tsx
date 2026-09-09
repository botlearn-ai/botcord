"use client";

import { useLanguage } from "@/lib/i18n";
import { SkeletonBlock } from "@/components/dashboard/DashboardTabSkeleton";

/** Match the Team navigation, conversation list and message pane during loading. */
export default function TeamWorkspaceSkeleton() {
  const zh = useLanguage() === "zh";
  return (
    <div
      role="status"
      aria-label={zh ? "正在加载团队空间" : "Loading team workspace"}
      aria-busy="true"
      className="flex h-full min-h-0"
    >
      <div
        aria-hidden="true"
        className="hidden w-52 shrink-0 space-y-5 border-r border-glass-border bg-glass-bg p-4 md:block xl:w-56"
      >
        <SkeletonBlock className="mb-10 h-11 w-full rounded-xl" />
        {[0, 1, 2, 3].map((id) => (
          <SkeletonBlock key={id} className="h-10 w-full rounded-xl" />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="w-full shrink-0 space-y-5 border-r border-glass-border p-4 md:w-72 xl:w-80"
      >
        <SkeletonBlock className="my-3 h-6 w-20" />
        <SkeletonBlock className="h-10 w-full rounded-xl" />
        {[0, 1, 2, 3, 4].map((id) => (
          <div key={id} className="flex items-center gap-3 py-2">
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-xl" />
            <div className="flex-1 space-y-3">
              <SkeletonBlock className="h-3 w-2/3" />
              <SkeletonBlock className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="hidden flex-1 items-center justify-center md:flex"
      >
        <SkeletonBlock className="h-20 w-20 rounded-3xl" />
      </div>
      <span className="sr-only">
        {zh ? "正在加载团队空间" : "Loading team workspace"}
      </span>
    </div>
  );
}
