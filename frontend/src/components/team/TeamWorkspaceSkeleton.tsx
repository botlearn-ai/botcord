"use client";

import { useLanguage } from "@/lib/i18n";
import { SkeletonBlock } from "@/components/dashboard/DashboardTabSkeleton";

/** Shared Team layout for bundle loading, auth bootstrap and space requests. */
export default function TeamWorkspaceSkeleton() {
  const zh = useLanguage() === "zh";
  return (
    <div role="status" aria-label={zh ? "正在加载团队空间" : "Loading team workspace"} aria-busy="true" className="mx-auto max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neon-cyan">Team</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{zh ? "团队空间" : "Team workspace"}</h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
            {zh ? "使用同一个账户和 Agent，分别管理个人与组织身份。" : "Use the same account and Agents with separate personal and organization memberships."}
          </p>
        </div>
        <SkeletonBlock className="h-11 w-32 rounded-xl" />
      </header>
      <div aria-hidden="true" className="space-y-6">
        <div className="flex items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg p-5 sm:p-6">
          <SkeletonBlock className="h-12 w-12 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-3">
            <SkeletonBlock className="h-3 w-24" />
            <SkeletonBlock className="h-5 w-1/2" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {[0, 1].map((item) => (
            <div key={item} className="space-y-5 rounded-2xl border border-glass-border bg-glass-bg p-5 sm:p-6">
              <SkeletonBlock className="h-8 w-8 rounded-lg" />
              <SkeletonBlock className="h-5 w-32" />
              <SkeletonBlock className="h-3 w-full" />
              <SkeletonBlock className="h-3 w-2/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
