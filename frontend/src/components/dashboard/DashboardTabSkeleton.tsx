"use client";

/**
 * [INPUT]: Tailwind dashboard tokens and a tab variant
 * [OUTPUT]: Shared tab-specific skeletons for dashboard secondary panels and main panes
 * [POS]: Loading UI primitives for dashboard tab transitions and data hydration
 * [PROTOCOL]: Update this header when behavior changes, then check README.md
 */
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";

type TabSkeletonVariant = "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots";

export function SkeletonBlock({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
}

function HeaderSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "border-b border-glass-border px-3 py-3" : "border-b border-glass-border px-6 py-4"}>
      <SkeletonBlock className={compact ? "h-4 w-28" : "h-5 w-36"} />
      <SkeletonBlock className={compact ? "mt-2 h-3 w-40 bg-glass-border/40" : "mt-2 h-3 w-56 bg-glass-border/40"} />
    </div>
  );
}

export function SidebarListSkeleton({ rows = 7, withAvatar = true }: { rows?: number; withAvatar?: boolean }) {
  return (
    <div className="space-y-1 p-2">
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
          {withAvatar ? <SkeletonBlock className="h-9 w-9 shrink-0 rounded-xl" /> : null}
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-3.5 w-3/5" />
            <SkeletonBlock className="mt-2 h-2.5 w-4/5 bg-glass-border/40" />
          </div>
        </div>
      ))}
    </div>
  );
}

function CardGridSkeleton({ rows = 6, statCards = false }: { rows?: number; statCards?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <div className="flex items-start gap-3">
            <SkeletonBlock className="h-10 w-10 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <SkeletonBlock className="h-4 w-2/3" />
              <SkeletonBlock className="mt-2 h-3 w-1/2 bg-glass-border/40" />
              <SkeletonBlock className="mt-3 h-3 w-full bg-glass-border/40" />
            </div>
          </div>
          {statCards ? (
            <div className="mt-4 grid grid-cols-4 gap-2 border-t border-glass-border pt-3">
              {Array.from({ length: 4 }).map((_, statIdx) => (
                <SkeletonBlock key={statIdx} className="h-10 rounded-lg bg-glass-border/40" />
              ))}
            </div>
          ) : (
            <SkeletonBlock className="mt-4 h-3 w-1/3 bg-glass-border/40" />
          )}
        </div>
      ))}
    </div>
  );
}

function ExploreGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: 10 }).map((_, idx) => (
        <div key={idx} className="rounded-xl border border-glass-border bg-deep-black-light p-3">
          <SkeletonBlock className="h-11 w-11 rounded-xl" />
          <SkeletonBlock className="mt-3 h-3.5 w-3/4" />
          <SkeletonBlock className="mt-2 h-2.5 w-1/2 bg-glass-border/40" />
          <SkeletonBlock className="mt-3 h-2.5 w-full bg-glass-border/40" />
          <SkeletonBlock className="mt-1.5 h-2.5 w-5/6 bg-glass-border/40" />
        </div>
      ))}
    </div>
  );
}

function WalletSkeleton() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-6">
        <SkeletonBlock className="h-3 w-28" />
        <SkeletonBlock className="mt-4 h-10 w-56" />
        <div className="mt-5 grid grid-cols-2 gap-4">
          <SkeletonBlock className="h-20 rounded-xl bg-glass-border/40" />
          <SkeletonBlock className="h-20 rounded-xl bg-glass-border/40" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, idx) => (
          <SkeletonBlock key={idx} className="h-24 rounded-xl bg-glass-border/40" />
        ))}
      </div>
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-5">
        <SkeletonBlock className="h-4 w-36" />
        <SkeletonBlock className="mt-2 h-3 w-52 bg-glass-border/40" />
        <div className="mt-4 space-y-3">
          {Array.from({ length: 3 }).map((_, idx) => (
            <SkeletonBlock key={idx} className="h-16 rounded-xl bg-glass-border/40" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, idx) => (
          <SkeletonBlock key={idx} className="h-24 rounded-xl bg-glass-border/40" />
        ))}
      </div>
      <div>
        <SkeletonBlock className="mb-3 h-4 w-32" />
        <div className="space-y-2">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="flex gap-3 rounded-xl border border-glass-border bg-glass-bg p-3">
              <SkeletonBlock className="h-8 w-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <SkeletonBlock className="h-3.5 w-3/5" />
                <SkeletonBlock className="mt-2 h-3 w-4/5 bg-glass-border/40" />
              </div>
              <SkeletonBlock className="h-3 w-10 bg-glass-border/40" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function DashboardMainSkeleton({ variant }: { variant: TabSkeletonVariant }) {
  if (variant === "wallet") return <WalletSkeleton />;
  if (variant === "activity") return <ActivitySkeleton />;
  if (variant === "explore") return <ExploreGridSkeleton />;
  if (variant === "bots") return <CardGridSkeleton rows={4} statCards />;
  if (variant === "home") {
    return (
      <div className="space-y-8">
        <div>
          <SkeletonBlock className="h-10 w-72" />
          <SkeletonBlock className="mt-3 h-4 w-96 bg-glass-border/40" />
        </div>
        <CardGridSkeleton rows={3} statCards />
        <ExploreGridSkeleton />
      </div>
    );
  }
  return <CardGridSkeleton rows={6} />;
}

export default function DashboardTabSkeleton({
  variant,
  compactHeader = false,
}: {
  variant: TabSkeletonVariant;
  compactHeader?: boolean;
}) {
  if (variant === "messages") {
    return <DashboardMessagePaneSkeleton />;
  }

  return (
    <div className="flex h-full flex-col bg-deep-black">
      <HeaderSkeleton compact={compactHeader} />
      <div className={variant === "explore" || variant === "home" || variant === "bots" ? "flex-1 overflow-y-auto px-6 py-6" : "flex-1 overflow-y-auto px-5 py-4"}>
        <DashboardMainSkeleton variant={variant} />
      </div>
    </div>
  );
}
