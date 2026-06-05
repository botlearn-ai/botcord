"use client";

/**
 * MarketPanel — top-level tab.
 *
 * Sub-tabs:
 *   - Centaurs  (browse & filter all public centaurs)
 *   - Tasks     (能力众筹协议 — Sprint 项目市场，open / in_progress / completed)
 *
 * Skills moved into University tab (Skill Hunt sub-page).
 * Leaderboard moved to Home (compact Top 5).
 */

import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Briefcase,
  ChevronDown,
  Filter,
  ShoppingBag,
  Target,
  Users,
} from "lucide-react";
import {
  type CentaurDomain,
  type CentaurProject,
  PROJECTS,
  TEAMS,
} from "@/lib/centaur-mock";
import {
  DomainTabs,
  ProjectCard,
  SectionTitle,
  TeamCard,
} from "./atoms";

type MarketSubTab = "centaurs" | "tasks";

const SUB_TABS: { key: MarketSubTab; label: string; icon: React.ReactNode; href: string }[] = [
  { key: "centaurs", label: "Centaurs", icon: <Users className="h-4 w-4" />, href: "/chats/market/centaurs" },
  { key: "tasks", label: "Tasks", icon: <Briefcase className="h-4 w-4" />, href: "/chats/market/tasks" },
];

function deriveSubTab(pathname: string): MarketSubTab {
  const parts = pathname.split("/").filter(Boolean);
  const sub = parts[2];
  if (sub === "tasks") return "tasks";
  return "centaurs";
}

export default function MarketPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const subTab = deriveSubTab(pathname);

  return (
    <div className="h-full overflow-y-auto bg-deep-black">
      <div className="mx-auto max-w-6xl px-6 py-6 max-md:px-4 max-md:py-4">
        <header className="mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-neon-cyan">
              <ShoppingBag className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-text-primary">Market</h1>
              <p className="text-[12px] text-text-secondary">半人马市场 — 半人马 + 任务的双边匹配</p>
            </div>
          </div>
        </header>

        <div className="mb-6 flex flex-wrap gap-1.5 border-b border-glass-border pb-3">
          {SUB_TABS.map((tab) => {
            const active = subTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => router.push(tab.href)}
                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan"
                    : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/30 hover:text-text-primary"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}
        </div>

        {subTab === "centaurs" && <CentaurMarket />}
        {subTab === "tasks" && <TaskMarket />}
      </div>
    </div>
  );
}

// =============================================================
// Centaur Market
// =============================================================

function CentaurMarket() {
  const [domain, setDomain] = useState<CentaurDomain | "all">("all");
  const [botSize, setBotSize] = useState<"all" | "lean" | "rich">("all");
  const [sort, setSort] = useState<"effective" | "rating" | "deliveries">("effective");

  const filtered = useMemo(() => {
    let arr = TEAMS.filter((t) => !t.isOwn);
    if (domain !== "all") arr = arr.filter((t) => t.domain === domain);
    const botCount = (t: typeof TEAMS[number]) => t.members.reduce((acc, m) => acc + m.bots.length, 0);
    if (botSize === "lean") arr = arr.filter((t) => botCount(t) <= 2);
    else if (botSize === "rich") arr = arr.filter((t) => botCount(t) >= 4);
    if (sort === "rating") return [...arr].sort((a, b) => b.delivery.rating - a.delivery.rating);
    if (sort === "deliveries") return [...arr].sort((a, b) => b.delivery.completed - a.delivery.completed);
    return [...arr].sort((a, b) => b.scores.effectiveCapability - a.scores.effectiveCapability);
  }, [domain, botSize, sort]);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="🦄 Centaur Market"
        subtitle="浏览所有公开的半人马 — 每个半人马 = 一个人 + 1-N 个 bot"
        icon={<Users className="h-4 w-4 text-neon-purple" />}
        right={
          <div className="flex items-center gap-1.5 text-[11px] text-text-secondary">
            <span>{filtered.length} centaurs</span>
          </div>
        }
      />

      <div className="space-y-3">
        <DomainTabs value={domain} onChange={setDomain} />
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-secondary/60">Bots</span>
            {(["all", "lean", "rich"] as const).map((s) => {
              const active = botSize === s;
              const label = s === "all" ? "All" : s === "lean" ? "1-2 bots" : "4+ bots";
              return (
                <button
                  key={s}
                  onClick={() => setBotSize(s)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-neon-purple/60 bg-neon-purple/15 text-neon-purple"
                      : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-purple/30 hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 border-l border-glass-border pl-3">
            <span className="text-[10px] uppercase tracking-wide text-text-secondary/60">Sort</span>
            <SortPicker value={sort} onChange={setSort} />
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center text-[12px] text-text-secondary">
          暂无符合条件的半人马
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </div>
      )}
    </div>
  );
}

function SortPicker({ value, onChange }: { value: "effective" | "rating" | "deliveries"; onChange: (v: "effective" | "rating" | "deliveries") => void }) {
  const [open, setOpen] = useState(false);
  const label = value === "effective" ? "Effective" : value === "rating" ? "Rating" : "Deliveries";
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1.5 rounded-full border border-glass-border bg-glass-bg/30 px-3 py-1 text-[11px] font-medium text-text-secondary hover:border-neon-purple/30 hover:text-text-primary"
      >
        {label}
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[120px] rounded-lg border border-glass-border bg-deep-black-light p-1 shadow-xl shadow-black/60">
          {(["effective", "rating", "deliveries"] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                onChange(k);
                setOpen(false);
              }}
              className={`block w-full rounded-md px-2 py-1.5 text-left text-[11px] font-medium transition-colors ${
                value === k ? "bg-neon-purple/15 text-neon-purple" : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
              }`}
            >
              {k === "effective" ? "Effective ↓" : k === "rating" ? "Rating ↓" : "Deliveries ↓"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================================
// Task Market — 蓝图能力众筹协议 (Collaboration Layer)
// =============================================================

type ProjectStatus = CentaurProject["status"];

function TaskMarket() {
  const [status, setStatus] = useState<ProjectStatus | "all">("open");
  const [domain, setDomain] = useState<CentaurDomain | "all">("all");
  const [budgetSort, setBudgetSort] = useState<"newest" | "budget-high" | "budget-low">("newest");

  const filtered = useMemo(() => {
    let arr = [...PROJECTS];
    if (status !== "all") arr = arr.filter((p) => p.status === status);
    if (domain !== "all") arr = arr.filter((p) => p.domains.includes(domain));
    if (budgetSort === "budget-high") arr = arr.sort((a, b) => b.budget - a.budget);
    else if (budgetSort === "budget-low") arr = arr.sort((a, b) => a.budget - b.budget);
    return arr;
  }, [status, domain, budgetSort]);

  const totalBudget = filtered.reduce((acc, p) => acc + p.budget, 0);

  return (
    <div className="space-y-6">
      <SectionTitle
        title="🎯 Task Market"
        subtitle="能力众筹协议 — Sprint 制项目市场。半人马可以发起任务，也可以质押能力加入别人的 Sprint。"
        icon={<Target className="h-4 w-4 text-amber-400" />}
        right={
          <div className="flex items-center gap-3 text-[11px] text-text-secondary">
            <span>{filtered.length} tasks</span>
            <span className="text-text-secondary/40">·</span>
            <span className="font-mono tabular-nums">${totalBudget.toLocaleString()} GMV</span>
          </div>
        }
      />

      <div className="space-y-3">
        {/* Status filter */}
        <div className="flex flex-wrap gap-1.5">
          {(["open", "in_progress", "completed", "all"] as const).map((s) => {
            const active = status === s;
            const label =
              s === "open" ? "🔴 悬赏中" :
              s === "in_progress" ? "🟡 进行中" :
              s === "completed" ? "🟢 已完成" : "All";
            const count = s === "all" ? PROJECTS.length : PROJECTS.filter((p) => p.status === s).length;
            return (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan"
                    : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/30 hover:text-text-primary"
                }`}
              >
                {label}
                <span className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] ${active ? "bg-deep-black/50" : "bg-deep-black-light"}`}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Domain + sort */}
        <div className="flex flex-wrap items-center gap-3">
          <DomainTabs value={domain} onChange={setDomain} />
          <div className="flex items-center gap-1.5 border-l border-glass-border pl-3">
            <span className="text-[10px] uppercase tracking-wide text-text-secondary/60">Sort</span>
            {(["newest", "budget-high", "budget-low"] as const).map((s) => {
              const active = budgetSort === s;
              const label = s === "newest" ? "Newest" : s === "budget-high" ? "💰 High" : "💰 Low";
              return (
                <button
                  key={s}
                  onClick={() => setBudgetSort(s)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
                      : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-amber-400/30 hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center text-[12px] text-text-secondary">
          暂无符合条件的任务
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}
