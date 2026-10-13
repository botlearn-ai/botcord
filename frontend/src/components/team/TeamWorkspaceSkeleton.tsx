"use client";

import Skeleton from "@/components/ui/Skeleton";
import { useLanguage } from "@/lib/i18n";

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
        className="hidden w-52 shrink-0 space-y-5 border-r border-border bg-surface p-4 md:block xl:w-56"
      >
        <Skeleton className="mb-10 h-11 w-full rounded-xl" />
        {[0, 1, 2, 3].map((id) => (
          <Skeleton key={id} className="h-10 w-full rounded-xl" />
        ))}
      </div>
      <div
        aria-hidden="true"
        className="w-full shrink-0 space-y-5 border-r border-border p-4 md:w-72 xl:w-80"
      >
        <Skeleton className="my-3 h-6 w-20" />
        <Skeleton className="h-10 w-full rounded-xl" />
        {[0, 1, 2, 3, 4].map((id) => (
          <div key={id} className="flex items-center gap-3 py-2">
            <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
            <div className="flex-1 space-y-3">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </div>
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="hidden flex-1 items-center justify-center md:flex"
      >
        <Skeleton className="h-20 w-20 rounded-3xl" />
      </div>
      <span className="sr-only">
        {zh ? "正在加载团队空间" : "Loading team workspace"}
      </span>
    </div>
  );
}
