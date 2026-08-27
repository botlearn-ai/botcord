"use client";

/**
 * [INPUT]: Tailwind dashboard tokens and a tab variant
 * [OUTPUT]: Shared tab-specific skeletons for dashboard secondary panels and main panes
 * [POS]: Loading UI primitives for dashboard tab transitions and data hydration
 * [PROTOCOL]: Update this header when behavior changes, then check README.md
 *
 * Every skeleton here mirrors the geometry of the panel it stands in for —
 * same page container (max width, padding), same section order, same card
 * shape and grid columns. When a panel's layout changes, update its skeleton
 * in the same commit, otherwise the first frame after a tab click no longer
 * matches what loads.
 */
import DashboardMessagePaneSkeleton from "./DashboardMessagePaneSkeleton";

type TabSkeletonVariant = "home" | "messages" | "contacts" | "explore" | "wallet" | "activity" | "bots";

export function SkeletonBlock({ className }: { className: string }) {
  return <div className={`dashboard-skeleton-block rounded ${className}`} />;
}

/**
 * Room rows are visually distinct from the generic sidebar list: `RoomList`
 * renders `mx-2 my-1 rounded-2xl px-3 py-3` cards with a 40px avatar and a
 * trailing timestamp. Keeping one shared implementation stops the shell
 * skeleton, the sidebar bootstrap skeleton and the in-list refresh skeleton
 * from drifting apart from the loaded layout.
 */
export function RoomRowsSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="py-1">
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="mx-2 my-1 flex items-center gap-3 rounded-2xl px-3 py-3">
          <SkeletonBlock className="h-10 w-10 shrink-0 rounded-xl bg-glass-border/45" />
          <div className="min-w-0 flex-1">
            <SkeletonBlock className="h-3.5 w-1/2" />
            <SkeletonBlock className="mt-2 h-2.5 w-4/5 bg-glass-border/40" />
          </div>
          <SkeletonBlock className="h-2.5 w-10 shrink-0 bg-glass-border/30" />
        </div>
      ))}
    </div>
  );
}

/**
 * `ContactsPanel`'s tree: collapsible section headers (uppercase, count on the
 * right) over `ListRow`s (px-3 py-2, 32px avatar, name + subtitle).
 */
export function ContactSectionsSkeleton({ sections = [4, 3] }: { sections?: number[] }) {
  return (
    <div>
      {sections.map((rows, sectionIdx) => (
        <div key={sectionIdx} className="border-b border-glass-border/50">
          <div className="flex w-full items-center justify-between px-3 py-2">
            <div className="flex items-center gap-1.5">
              <SkeletonBlock className="h-3 w-3 rounded bg-glass-border/40" />
              <SkeletonBlock className="h-2.5 w-16 bg-glass-border/45" />
            </div>
            <SkeletonBlock className="h-2.5 w-4 bg-glass-border/30" />
          </div>
          <div className="pb-2">
            {Array.from({ length: rows }).map((_, rowIdx) => (
              <div key={rowIdx} className="flex w-full items-center gap-2.5 px-3 py-2">
                <SkeletonBlock className="h-8 w-8 shrink-0 rounded-xl bg-glass-border/45" />
                <div className="min-w-0 flex-1">
                  <SkeletonBlock className="h-3.5 w-1/2" />
                  <SkeletonBlock className="mt-1.5 h-2.5 w-3/4 bg-glass-border/40" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** `ContactsPanel`'s pinned "new requests" row: px-3 py-3, 40px avatar. */
export function PinnedRequestRowSkeleton() {
  return (
    <div className="flex items-center gap-3 border-b border-glass-border px-3 py-3">
      <SkeletonBlock className="h-10 w-10 shrink-0 rounded-full bg-glass-border/45" />
      <div className="min-w-0 flex-1">
        <SkeletonBlock className="h-3.5 w-32" />
        <SkeletonBlock className="mt-2 h-2.5 w-24 bg-glass-border/40" />
      </div>
    </div>
  );
}

/** Mirrors `ChatPane`'s `MessagesEmptyState` — what /chats/messages resolves to. */
export function MessagesEmptyStateSkeleton() {
  return (
    <div className="dashboard-main flex min-w-0 flex-1 items-center justify-center px-6 py-10" aria-busy="true">
      <div className="w-full max-w-md text-center">
        <SkeletonBlock className="mx-auto mb-5 h-14 w-14 rounded-2xl bg-glass-border/35" />
        <SkeletonBlock className="mx-auto h-5 w-40" />
        <SkeletonBlock className="mx-auto mt-3 h-3.5 w-72 max-w-full bg-glass-border/40" />
        <SkeletonBlock className="mx-auto mt-5 h-6 w-56 max-w-full rounded-full bg-glass-border/30" />
      </div>
    </div>
  );
}

/** `HomePanel`'s SectionHeader: icon + title/subtitle on the left, "view all" on the right. */
function SectionHeaderSkeleton({ titleWidth = "w-28", subtitleWidth = "w-56", withShowAll = true }: {
  titleWidth?: string;
  subtitleWidth?: string;
  withShowAll?: boolean;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="flex items-center gap-2">
        <SkeletonBlock className="h-4 w-4 shrink-0 rounded bg-glass-border/45" />
        <div>
          <SkeletonBlock className={`h-4 ${titleWidth}`} />
          <SkeletonBlock className={`mt-1.5 h-2.5 ${subtitleWidth} bg-glass-border/40`} />
        </div>
      </div>
      {withShowAll ? <SkeletonBlock className="h-5 w-16 rounded-md bg-glass-border/35" /> : null}
    </div>
  );
}

/** `HomePanel`'s BotActivityCard: 36px avatar + name/status, then a 2x2 stat grid. */
function BotActivityCardSkeleton() {
  return (
    <div className="liquid-card w-full rounded-2xl border border-glass-border p-4">
      <div className="mb-3 flex items-center gap-2.5">
        <SkeletonBlock className="h-9 w-9 shrink-0 rounded-xl bg-glass-border/45" />
        <div className="min-w-0 flex-1">
          <SkeletonBlock className="h-3.5 w-2/3" />
          <SkeletonBlock className="mt-1.5 h-2.5 w-12 bg-glass-border/40" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="liquid-tool-surface rounded-lg px-2 py-1.5">
            <SkeletonBlock className="h-2 w-4/5 bg-glass-border/40" />
            <SkeletonBlock className="mt-1.5 h-3.5 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** `HomePanel`'s PersonCard: 40px avatar + name + badge pill, then a two-line bio. */
function PersonCardSkeleton() {
  return (
    <div className="liquid-card flex flex-col rounded-2xl border border-glass-border p-4">
      <div className="mb-2 flex items-center gap-2">
        <SkeletonBlock className="h-10 w-10 shrink-0 rounded-full bg-glass-border/45" />
        <div className="min-w-0 flex-1">
          <SkeletonBlock className="h-3.5 w-3/5" />
          <SkeletonBlock className="mt-1 h-3 w-14 rounded-full bg-glass-border/35" />
        </div>
      </div>
      <div className="min-h-[2rem]">
        <SkeletonBlock className="h-2.5 w-full bg-glass-border/40" />
        <SkeletonBlock className="mt-1.5 h-2.5 w-4/5 bg-glass-border/40" />
      </div>
    </div>
  );
}

/** `ExploreEntityCard` kind="room": 56px patterned cover, then px-3 py-2 body. */
function RoomEntityCardSkeleton() {
  return (
    <div className="liquid-card overflow-hidden rounded-xl border border-glass-border">
      <div className="relative h-14 w-full bg-glass-bg/40">
        <SkeletonBlock className="absolute left-3 top-2 h-7 w-7 rounded-md bg-glass-border/45" />
        <SkeletonBlock className="absolute right-2 top-2 h-4 w-14 rounded-full bg-glass-border/35" />
      </div>
      <div className="px-3 py-2">
        <SkeletonBlock className="h-3.5 w-3/5" />
        <SkeletonBlock className="mt-1 h-2.5 w-2/5 bg-glass-border/35" />
        <SkeletonBlock className="mt-1.5 h-2.5 w-full bg-glass-border/40" />
        <SkeletonBlock className="mt-1 h-2.5 w-4/5 bg-glass-border/40" />
        <div className="mt-1.5 flex items-center justify-end">
          <SkeletonBlock className="h-2.5 w-12 bg-glass-border/30" />
        </div>
      </div>
    </div>
  );
}

/** `ExploreEntityCard` kind="agent"/"human": rounded-xl p-3, 36px avatar + two-line bio. */
function PersonEntityCardSkeleton() {
  return (
    <div className="liquid-card rounded-xl border border-glass-border p-3">
      <div className="flex items-start gap-2.5">
        <SkeletonBlock className="h-9 w-9 shrink-0 rounded-full bg-glass-border/45" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <SkeletonBlock className="h-3.5 w-3/5" />
            <SkeletonBlock className="h-3 w-12 shrink-0 rounded-full bg-glass-border/35" />
          </div>
          <SkeletonBlock className="mt-1 h-2.5 w-2/3 bg-glass-border/35" />
        </div>
      </div>
      <SkeletonBlock className="mt-1.5 h-2.5 w-full bg-glass-border/40" />
      <SkeletonBlock className="mt-1 h-2.5 w-5/6 bg-glass-border/40" />
    </div>
  );
}

/** `ChatPane`'s explore grid — same columns as EXPLORE_GRID_CLASS. */
function ExploreGridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {Array.from({ length: 10 }).map((_, idx) => (
        <PersonEntityCardSkeleton key={idx} />
      ))}
    </div>
  );
}

/** `ChatPane`'s contacts/joined-rooms grid: rounded-2xl p-4 cards, 1/2/3 columns. */
function ContactsGridSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: rows }).map((_, idx) => (
        <div key={idx} className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <div className="flex items-center justify-between gap-2">
            <SkeletonBlock className="h-3.5 w-2/5" />
            <SkeletonBlock className="h-4 w-12 shrink-0 rounded bg-glass-border/35" />
          </div>
          <SkeletonBlock className="mt-1.5 h-2.5 w-3/5 bg-glass-border/35" />
          <SkeletonBlock className="mt-2.5 h-2.5 w-full bg-glass-border/40" />
          <SkeletonBlock className="mt-1.5 h-2.5 w-4/5 bg-glass-border/40" />
          <SkeletonBlock className="mt-2.5 h-2.5 w-1/3 bg-glass-border/30" />
        </div>
      ))}
    </div>
  );
}

/** `MyBotsPanel`'s BotsView card: rounded-2xl p-5, 48px avatar, 4-column stats. */
function BotCardSkeleton() {
  return (
    <div className="liquid-card rounded-2xl border border-glass-border p-5">
      <div className="mb-4 flex items-start gap-3">
        <SkeletonBlock className="h-12 w-12 shrink-0 rounded-xl bg-glass-border/45" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <SkeletonBlock className="h-4 w-1/3" />
            <SkeletonBlock className="h-4 w-14 rounded-full bg-glass-border/35" />
          </div>
          <SkeletonBlock className="mt-2 h-2.5 w-full bg-glass-border/40" />
          <SkeletonBlock className="mt-1.5 h-2.5 w-3/5 bg-glass-border/40" />
          <SkeletonBlock className="mt-2.5 h-2.5 w-2/5 bg-glass-border/30" />
        </div>
      </div>
      <div className="grid grid-cols-4 gap-2 border-t border-glass-border pt-3">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div key={idx} className="liquid-tool-surface rounded-lg px-2 py-1.5">
            <SkeletonBlock className="h-2 w-4/5 bg-glass-border/40" />
            <SkeletonBlock className="mt-1.5 h-3.5 w-8" />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-glass-border pt-2">
        <SkeletonBlock className="h-2.5 w-24 bg-glass-border/30" />
        <SkeletonBlock className="h-2.5 w-16 bg-glass-border/30" />
      </div>
    </div>
  );
}

/** `ActivityPanel`'s StatCard: rounded-xl p-4, label + mono value + optional sub. */
function ActivityStatsSkeleton() {
  return (
    <div className="grid grid-cols-3 gap-3">
      {Array.from({ length: 3 }).map((_, idx) => (
        <div key={idx} className="liquid-card rounded-xl border border-glass-border p-4">
          <SkeletonBlock className="mb-2 h-2 w-20 bg-glass-border/45" />
          <SkeletonBlock className="h-5 w-16" />
          <SkeletonBlock className="mt-2 h-2.5 w-24 bg-glass-border/35" />
        </div>
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <div className="space-y-6">
      <ActivityStatsSkeleton />
      <div>
        <SkeletonBlock className="mb-3 h-3.5 w-24" />
        <div className="space-y-2">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="liquid-list-row flex gap-3 rounded-xl border border-glass-border p-3">
              <SkeletonBlock className="h-8 w-8 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1">
                <SkeletonBlock className="h-3.5 w-3/5" />
                <SkeletonBlock className="mt-1.5 h-2.5 w-4/5 bg-glass-border/40" />
                <SkeletonBlock className="mt-1.5 h-2 w-1/4 bg-glass-border/30" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A `SearchBar` input: rounded-lg border px-3 py-2 text-sm. */
function SearchBarSkeleton({ className = "" }: { className?: string }) {
  return <SkeletonBlock className={`h-[38px] rounded-lg bg-glass-border/30 ${className}`} />;
}

/** The pill tab control used by MyBots / Explore. */
function PillTabsSkeleton({ tabs = 3, pillWidth = "w-16" }: { tabs?: number; pillWidth?: string }) {
  return (
    <div className="liquid-tabs inline-flex items-center gap-1 rounded-full border border-glass-border p-1">
      {Array.from({ length: tabs }).map((_, idx) => (
        <SkeletonBlock key={idx} className={`h-7 ${pillWidth} rounded-full bg-glass-border/35`} />
      ))}
    </div>
  );
}

/**
 * Body-level skeletons, for panels that own their header and render a skeleton
 * only inside their scroll area (ActivityPanel, ChatPane's explore/contacts).
 */
export function DashboardMainSkeleton({ variant }: { variant: TabSkeletonVariant }) {
  if (variant === "activity") return <ActivitySkeleton />;
  if (variant === "explore") return <ExploreGridSkeleton />;
  if (variant === "bots") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, idx) => <BotCardSkeleton key={idx} />)}
      </div>
    );
  }
  if (variant === "home") return <HomeSectionsSkeleton />;
  if (variant === "wallet") return <WalletSectionsSkeleton />;
  return <ContactsGridSkeleton />;
}

/** `HomePanel` body: greeting, my-bots grid, then three discovery sections. */
function HomeSectionsSkeleton() {
  return (
    <>
      <div className="mb-10">
        <SkeletonBlock className="h-9 w-80 max-w-full" />
        <SkeletonBlock className="mt-3 h-4 w-[26rem] max-w-full bg-glass-border/40" />
      </div>

      <section className="mb-10">
        <SectionHeaderSkeleton titleWidth="w-24" subtitleWidth="w-64" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, idx) => <BotActivityCardSkeleton key={idx} />)}
          <div className="liquid-empty-state flex min-h-[148px] w-full flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border/80 p-4">
            <SkeletonBlock className="mb-3 h-11 w-11 rounded-xl bg-glass-border/35" />
            <SkeletonBlock className="h-3.5 w-24 bg-glass-border/40" />
          </div>
        </div>
      </section>

      <section className="mb-10">
        <SectionHeaderSkeleton titleWidth="w-20" subtitleWidth="w-56" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => <RoomEntityCardSkeleton key={idx} />)}
        </div>
      </section>

      <section className="mb-10">
        <SectionHeaderSkeleton titleWidth="w-24" subtitleWidth="w-52" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => <PersonCardSkeleton key={idx} />)}
        </div>
      </section>

      <section className="mb-6">
        <SectionHeaderSkeleton titleWidth="w-20" subtitleWidth="w-48" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => <PersonCardSkeleton key={idx} />)}
        </div>
      </section>
    </>
  );
}

/** `WalletPanel` body: total card with CTAs, bot balances, then the ledger. */
function WalletSectionsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="liquid-card rounded-2xl border border-glass-border p-6">
        <SkeletonBlock className="mb-1 h-3 w-28 bg-glass-border/45" />
        <SkeletonBlock className="mb-5 h-9 w-56" />
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, idx) => (
            <div key={idx} className="liquid-tool-surface rounded-xl border border-glass-border p-4">
              <SkeletonBlock className="mb-1 h-2 w-20 bg-glass-border/45" />
              <SkeletonBlock className="h-6 w-28" />
            </div>
          ))}
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, idx) => (
            <SkeletonBlock key={idx} className="h-11 rounded-xl bg-glass-border/35" />
          ))}
        </div>
      </div>

      <div className="liquid-card rounded-2xl border border-glass-border p-5">
        <SkeletonBlock className="mb-3 h-3.5 w-28" />
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div key={idx} className="flex items-center gap-3 rounded-xl border border-glass-border px-3.5 py-3">
              <SkeletonBlock className="h-9 w-9 shrink-0 rounded-xl bg-glass-border/45" />
              <div className="min-w-0 flex-1">
                <SkeletonBlock className="h-3.5 w-2/5" />
                <SkeletonBlock className="mt-1.5 h-2.5 w-3/5 bg-glass-border/35" />
              </div>
              <div className="text-right">
                <SkeletonBlock className="ml-auto h-4 w-20" />
                <SkeletonBlock className="ml-auto mt-1 h-2 w-10 bg-glass-border/35" />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="liquid-card rounded-2xl border border-glass-border p-5">
        <SkeletonBlock className="h-3.5 w-36" />
        <SkeletonBlock className="mt-1.5 h-2.5 w-52 bg-glass-border/40" />
        <div className="liquid-tool-surface mt-3 overflow-hidden rounded-xl border border-glass-border">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div key={idx} className="flex items-center justify-between gap-4 border-b border-glass-border/40 px-4 py-3 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <SkeletonBlock className="h-3.5 w-20" />
                  <SkeletonBlock className="h-3.5 w-12 rounded bg-glass-border/35" />
                </div>
                <SkeletonBlock className="mt-1.5 h-2.5 w-32 bg-glass-border/35" />
              </div>
              <div className="text-right">
                <SkeletonBlock className="ml-auto h-2.5 w-20 bg-glass-border/40" />
                <SkeletonBlock className="ml-auto mt-1 h-2 w-8 bg-glass-border/30" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Full-pane skeletons used while a tab navigation is pending. Each branch
 * reproduces the target panel's own page chrome — HomePanel/MyBotsPanel/
 * WalletPanel are centered `max-w-5xl` pages with no toolbar, while
 * ActivityPanel and ChatPane's contacts view do have one.
 */
export default function DashboardTabSkeleton({
  variant,
  hasOpenConversation = false,
}: {
  variant: TabSkeletonVariant;
  hasOpenConversation?: boolean;
}) {
  if (variant === "messages") {
    return hasOpenConversation ? <DashboardMessagePaneSkeleton /> : <MessagesEmptyStateSkeleton />;
  }

  if (variant === "home") {
    return (
      <div className="dashboard-main h-full overflow-y-auto" aria-busy="true">
        <div className="mx-auto max-w-5xl px-6 pb-10 pt-16">
          <HomeSectionsSkeleton />
        </div>
      </div>
    );
  }

  if (variant === "bots") {
    return (
      <div className="dashboard-main h-full overflow-y-auto" aria-busy="true">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <div className="mb-6">
            <SkeletonBlock className="h-7 w-40" />
            <SkeletonBlock className="mt-2 h-3.5 w-72 max-w-full bg-glass-border/40" />
          </div>
          <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
            <PillTabsSkeleton tabs={2} pillWidth="w-20" />
            <SkeletonBlock className="h-9 w-28 rounded-lg bg-glass-border/35" />
          </div>
          <DashboardMainSkeleton variant="bots" />
        </div>
      </div>
    );
  }

  if (variant === "wallet") {
    return (
      <div className="dashboard-main h-full overflow-y-auto" aria-busy="true">
        <div className="mx-auto max-w-5xl px-6 py-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <SkeletonBlock className="h-7 w-32" />
              <SkeletonBlock className="mt-2 h-3.5 w-64 max-w-full bg-glass-border/40" />
            </div>
            <SkeletonBlock className="h-9 w-9 shrink-0 rounded-lg bg-glass-border/35" />
          </div>
          <WalletSectionsSkeleton />
        </div>
      </div>
    );
  }

  if (variant === "explore") {
    return (
      <div className="dashboard-main relative flex h-full flex-col overflow-hidden" aria-busy="true">
        <div className="mx-auto w-full max-w-5xl px-6 pt-8">
          <SkeletonBlock className="h-7 w-24" />
          <SkeletonBlock className="mt-2 h-3.5 w-80 max-w-full bg-glass-border/40" />
          <div className="mt-5">
            <PillTabsSkeleton tabs={3} pillWidth="w-16" />
          </div>
          <SearchBarSkeleton className="mt-5 w-full max-w-xl" />
        </div>
        <div className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-6 py-6">
          <ExploreGridSkeleton />
        </div>
      </div>
    );
  }

  if (variant === "activity") {
    return (
      <div className="dashboard-main flex h-full flex-col overflow-hidden" aria-busy="true">
        <div className="liquid-toolbar flex items-center justify-between border-b border-glass-border px-6 py-4">
          <SkeletonBlock className="h-4 w-20" />
          <div className="liquid-tabs flex gap-1 rounded-lg border border-glass-border p-0.5">
            {Array.from({ length: 3 }).map((_, idx) => (
              <SkeletonBlock key={idx} className="h-6 w-14 rounded-md bg-glass-border/35" />
            ))}
          </div>
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          <ActivitySkeleton />
        </div>
      </div>
    );
  }

  // contacts
  return (
    <div className="dashboard-main flex h-full flex-col overflow-hidden" aria-busy="true">
      <div className="border-b border-glass-border px-5 py-4">
        <SkeletonBlock className="h-4 w-24" />
        <SkeletonBlock className="mt-2 h-3 w-56 max-w-full bg-glass-border/40" />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <SearchBarSkeleton className="min-w-[240px] max-w-xl flex-1" />
          <SkeletonBlock className="h-9 w-24 rounded bg-glass-border/35" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <ContactsGridSkeleton />
      </div>
    </div>
  );
}
