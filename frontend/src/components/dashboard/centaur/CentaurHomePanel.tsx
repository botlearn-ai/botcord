"use client";

/**
 * CentaurHomePanel — explore branch demo home.
 *
 * Sections (top to bottom):
 *   1. Identity strip (you are Centaur Lv N)
 *   2. Today's briefings (INSIGHT — hero region)
 *   3. My Teams (horizontal cards)
 *   4. This Week (rank / new credentials / evals)
 *   5. Trending Teams (domain-filtered grid)
 *   6. Hot Projects (status-filtered list)
 */

import { useMemo, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import {
  Award,
  BookOpen,
  Briefcase,
  CheckCircle2,
  ChevronRight,
  Clock,
  Flame,
  Play,
  Search,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Trophy,
  Zap,
} from "lucide-react";
import {
  BRIEFINGS,
  type Briefing,
  type CentaurDomain,
  type CentaurProject,
  type CourseTrack,
  type CourseUnit,
  LEADERBOARD,
  PROJECTS,
  myInProgressProjects,
  myNextCourseUnits,
  myTeams,
  pendingBriefings,
  personalTeam,
  teamById,
  trendingTeams,
} from "@/lib/centaur-mock";
import {
  BriefingCard,
  CentaurStack,
  CtaPill,
  DomainTabs,
  PostRow,
  ProjectCard,
  SectionTitle,
  Sparkline,
  StatTile,
  TeamCard,
  domainMeta,
} from "./atoms";

type ProjectStatus = CentaurProject["status"];

export default function CentaurHomePanel() {
  const router = useRouter();
  const me = personalTeam();
  const ownedCentaurs = myTeams();
  const briefings = pendingBriefings();
  const fallbackBriefings = BRIEFINGS;
  const visibleBriefings = briefings.length ? briefings : fallbackBriefings.slice(0, 2);
  const nextCourseUnits = useMemo(() => myNextCourseUnits(), []);
  const inProgressProjects = useMemo(() => myInProgressProjects(), []);

  const [trendingDomain, setTrendingDomain] = useState<CentaurDomain | "all">("all");
  const [projectStatus, setProjectStatus] = useState<ProjectStatus>("open");

  const trending = useMemo(() => {
    const arr = trendingTeams();
    if (trendingDomain === "all") return arr;
    return arr.filter((t) => t.domain === trendingDomain);
  }, [trendingDomain]);

  const visibleProjects = useMemo(() => PROJECTS.filter((p) => p.status === projectStatus), [projectStatus]);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-deep-black">
      <div className="mx-auto max-w-6xl px-6 py-8 max-md:px-4 max-md:py-5">
        {/* ============================================================
            Hero: identity + natural-language intent search (combined)
           ============================================================ */}
        <HomeHero ownedCentaurs={ownedCentaurs} />

        {/* ============================================================
            Section 2: 今日工作台 (Today's Workbench)
            三块: 简报(待判断) + 课程(待学习) + 任务(进行中)
           ============================================================ */}
        <section className="mb-10">
          <SectionTitle
            title="📋 今日工作台"
            subtitle="今天等你做的事 — 简报要你判断、课程要你学习、任务要你推进"
            icon={<Briefcase className="h-4 w-4 text-neon-cyan" />}
          />

          <div className="space-y-5">
            {/* Sub-block 1: Briefings — 3 横向卡片，省略号截断 */}
            <WorkbenchBlock
              title="💡 今日简报"
              count={visibleBriefings.length}
              countLabel="待判断"
              right={
                <CtaPill tone="ghost" onClick={() => router.push("/chats/centaur-team/inbox")}>
                  全部 Inbox
                </CtaPill>
              }
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {visibleBriefings.slice(0, 3).map((b) => (
                  <CompactBriefingCard
                    key={b.id}
                    briefing={b}
                    onOpen={() => router.push("/chats/centaur-team/inbox")}
                  />
                ))}
              </div>
            </WorkbenchBlock>

            {/* Sub-block 2: Today's courses */}
            <WorkbenchBlock
              title="📚 今日课程"
              count={nextCourseUnits.length}
              countLabel="待学习"
              right={
                <CtaPill tone="ghost" onClick={() => router.push("/chats/university/courses")}>
                  Go to University
                </CtaPill>
              }
            >
              {nextCourseUnits.length === 0 ? (
                <div className="rounded-xl border border-dashed border-glass-border bg-deep-black-light/40 px-4 py-6 text-center text-[12px] text-text-secondary">
                  今天没有待学的课程单元 — 试试去 University 选一门新课
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {nextCourseUnits.map(({ course, nextUnit }) => (
                    <TodayCourseRow
                      key={course.id}
                      course={course}
                      nextUnit={nextUnit}
                      onOpen={() => router.push(`/chats/university/${course.slug}`)}
                    />
                  ))}
                </div>
              )}
            </WorkbenchBlock>

            {/* Sub-block 3: In-progress tasks */}
            <WorkbenchBlock
              title="🎯 进行中任务"
              count={inProgressProjects.length}
              countLabel="待推进"
              right={
                <CtaPill tone="ghost" onClick={() => router.push("/chats/market/tasks")}>
                  Browse all in Market
                </CtaPill>
              }
            >
              {inProgressProjects.length === 0 ? (
                <div className="rounded-xl border border-dashed border-glass-border bg-deep-black-light/40 px-4 py-6 text-center text-[12px] text-text-secondary">
                  你的半人马目前没有进行中的 Sprint — 去 Market 看看悬赏任务
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {inProgressProjects.map((p) => (
                    <TodayTaskRow key={p.id} project={p} />
                  ))}
                </div>
              )}
            </WorkbenchBlock>
          </div>
        </section>

        {/* ============================================================
            Section 3: My Teams
           ============================================================ */}
        <section className="mb-8">
          <SectionTitle
            title="My Centaurs"
            subtitle="你为不同领域调教的半人马 — 每个 = 你 + 一组专精的 Bot。一个人可以有多个半人马。"
            icon={<Zap className="h-4 w-4 text-neon-purple" />}
            right={
              <CtaPill tone="ghost" onClick={() => router.push("/chats/centaur-team")}>
                Go to Centaur Team
              </CtaPill>
            }
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {myTeams().map((team) => (
              <TeamCard key={team.id} team={team} onClick={() => router.push("/chats/centaur-team")} />
            ))}
          </div>
        </section>

        {/* ============================================================
            Section 4: This Week
           ============================================================ */}
        <section className="mb-8">
          <SectionTitle
            title="This Week"
            subtitle="你的半人马本周指标变化"
            icon={<TrendingUp className="h-4 w-4 text-emerald-400" />}
          />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatTile
              label="Effective Capability"
              value={me?.scores.effectiveCapability ?? 62}
              delta={
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <TrendingUp className="h-3 w-3" />
                  +4 vs last week
                </span>
              }
              icon={<Sparkles className="h-4 w-4" />}
              tone="cyan"
            />
            <StatTile
              label="Leaderboard Rank"
              value="#28"
              delta={
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <TrendingUp className="h-3 w-3" />
                  ↑ 6 positions
                </span>
              }
              icon={<Trophy className="h-4 w-4" />}
              tone="amber"
            />
            <StatTile
              label="New Credentials"
              value="1"
              delta="Verified Centaur · Design · Lv 3"
              icon={<Award className="h-4 w-4" />}
              tone="purple"
            />
            <StatTile
              label="Pending Briefings"
              value={briefings.length}
              delta={<span>等待你的判断响应</span>}
              icon={<Zap className="h-4 w-4" />}
              tone="green"
            />
          </div>
          {me && (
            <div className="mt-4 rounded-2xl border border-glass-border bg-deep-black-light p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] text-text-secondary">7-day effective_capability trend</div>
                <div className="font-mono text-sm font-semibold text-neon-cyan tabular-nums">{me.weeklyTrend.at(-1)}</div>
              </div>
              <div className="mt-2">
                <Sparkline data={me.weeklyTrend} />
              </div>
            </div>
          )}
        </section>

        {/* ============================================================
            Section 4.5: Top Centaurs (compact leaderboard)
           ============================================================ */}
        <section className="mb-8">
          <SectionTitle
            title="🏆 Top Centaurs · This Week"
            subtitle="按 effective_capability 排名 — 蓝图半人马网络的核心指标"
            icon={<Trophy className="h-4 w-4 text-amber-400" />}
          />
          <div className="rounded-2xl border border-glass-border bg-deep-black-light p-2">
            {LEADERBOARD.slice(0, 5).map((entry) => (
              <CompactLeaderboardRow key={entry.teamId} entry={entry} />
            ))}
          </div>
        </section>

        {/* ============================================================
            Section 5: Trending Teams
           ============================================================ */}
        <section className="mb-8">
          <SectionTitle
            title="Trending Centaurs"
            subtitle="这周最活跃的半人马 — 按领域筛选"
            icon={<Flame className="h-4 w-4 text-rose-400" />}
            right={
              <CtaPill tone="ghost" onClick={() => router.push("/chats/market/centaurs")}>
                Browse all in Market
              </CtaPill>
            }
          />
          <div className="mb-4">
            <DomainTabs value={trendingDomain} onChange={setTrendingDomain} />
          </div>
          {trending.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center text-[12px] text-text-secondary">
              这个领域暂时还没有热门团队 — 你可以是第一个。
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {trending.map((team) => (
                <TeamCard key={team.id} team={team} onClick={() => router.push("/chats/centaur-team")} />
              ))}
            </div>
          )}
        </section>

        {/* ============================================================
            Section 6: Hot Projects
           ============================================================ */}
        <section className="mb-12">
          <SectionTitle
            title="Hot Projects"
            subtitle="能力众筹协议 — Sprint 制项目。质押你的团队能力，按贡献分配收益。"
            icon={<TrendingUp className="h-4 w-4 text-amber-400" />}
            right={
              <CtaPill tone="ghost" onClick={() => router.push("/chats/market/tasks")}>
                Browse all in Market
              </CtaPill>
            }
          />
          <div className="mb-4 flex flex-wrap gap-1.5">
            {(["open", "in_progress", "completed"] as ProjectStatus[]).map((status) => {
              const active = projectStatus === status;
              const label = status === "open" ? "🔴 悬赏中" : status === "in_progress" ? "🟡 进行中" : "🟢 已完成";
              const count = PROJECTS.filter((p) => p.status === status).length;
              return (
                <button
                  key={status}
                  onClick={() => setProjectStatus(status)}
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
          {visibleProjects.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center text-[12px] text-text-secondary">
              暂无项目
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {visibleProjects.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// =============================================================
// CompactLeaderboardRow — Home 紧凑版排行行
// =============================================================

function CompactLeaderboardRow({ entry }: { entry: typeof LEADERBOARD[number] }) {
  const team = teamById(entry.teamId);
  if (!team) return null;
  const rankBadge =
    entry.rank === 1
      ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
      : entry.rank === 2
      ? "border-slate-300/60 bg-slate-300/15 text-slate-200"
      : entry.rank === 3
      ? "border-orange-400/60 bg-orange-400/15 text-orange-300"
      : "border-glass-border bg-glass-bg text-text-secondary";
  const delta = entry.delta === 0 ? (
    <span className="text-[10px] text-text-secondary/50">—</span>
  ) : entry.delta > 0 ? (
    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-emerald-400">
      <TrendingUp className="h-2.5 w-2.5" /> {entry.delta}
    </span>
  ) : (
    <span className="flex items-center gap-0.5 text-[10px] font-semibold text-rose-400">
      <TrendingDown className="h-2.5 w-2.5" /> {Math.abs(entry.delta)}
    </span>
  );

  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-glass-bg/40">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-[11px] font-bold tabular-nums ${rankBadge}`}>
        {entry.rank}
      </div>
      <div className="w-7 shrink-0">{delta}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold text-text-primary">{team.name}</div>
        <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-text-secondary/70">
          {team.tagline}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-sm font-bold text-neon-cyan tabular-nums">{team.scores.effectiveCapability}</div>
        <div className="text-[9px] uppercase tracking-wide text-text-secondary/60">Effective</div>
      </div>
    </div>
  );
}

// =============================================================
// HomeHero — Lovart-style centered hero: identity + intent search
// =============================================================

const PROMPT_SUGGESTIONS = [
  "帮我做 SaaS 竞品分析",
  "12 周增长实验设计",
  "把 100 页合同压成 5 条风险点",
  "1 个 idea → 25 条短视频脚本",
  "白皮书翻译为投资人 narrative",
];

function HomeHero({
  ownedCentaurs,
}: {
  ownedCentaurs: ReturnType<typeof myTeams>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const submit = (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    router.push(`/chats/search?q=${encodeURIComponent(trimmed)}`);
  };

  const userName = ownedCentaurs[0]?.members[0]?.human.name ?? "Jin";
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 5) return "夜深了";
    if (h < 12) return "早上好";
    if (h < 14) return "中午好";
    if (h < 18) return "下午好";
    return "晚上好";
  })();

  return (
    <section className="mb-10 flex flex-col items-center px-4 pt-10 pb-2 text-center">
      {/* Personal greeting */}
      <div className="text-[13px] text-text-secondary">
        {greeting}，<span className="font-medium text-text-primary">{userName}</span>
      </div>

      {/* Heading */}
      <h1 className="mt-3 text-3xl font-semibold leading-tight text-text-primary max-md:text-2xl">
        让半人马帮你干活
      </h1>

      {/* Search input */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(query);
        }}
        className="mt-6 w-full max-w-2xl"
      >
        <div className="group flex items-center gap-3 rounded-2xl border border-glass-border bg-deep-black-light px-4 py-3 transition-colors focus-within:border-neon-cyan/60 focus-within:shadow-[0_0_30px_rgba(0,240,255,0.08)]">
          <Search className="h-5 w-5 shrink-0 text-text-secondary/60 group-focus-within:text-neon-cyan" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="你想做什么？"
            className="flex-1 bg-transparent text-[15px] text-text-primary placeholder:text-text-secondary/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={!query.trim()}
            aria-label="Submit"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan transition-all hover:bg-neon-cyan/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Sparkles className="h-4 w-4" />
          </button>
        </div>
      </form>

      {/* Prompt chips */}
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        {PROMPT_SUGGESTIONS.map((p) => (
          <button
            key={p}
            onClick={() => submit(p)}
            className="rounded-full border border-glass-border bg-glass-bg/30 px-3 py-1 text-[11px] text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-text-primary"
          >
            {p}
          </button>
        ))}
      </div>
    </section>
  );
}

// =============================================================
// CompactBriefingCard — 横向 3 列简报卡，省略号截断
// =============================================================

function CompactBriefingCard({ briefing, onOpen }: { briefing: Briefing; onOpen: () => void }) {
  const team = teamById(briefing.teamId);
  const proposedCount = briefing.proposed?.length ?? 0;
  return (
    <button
      onClick={onOpen}
      className="group flex h-full flex-col gap-2 rounded-xl border border-glass-border bg-deep-black-light px-3 py-2.5 text-left transition-colors hover:border-neon-cyan/40"
    >
      {/* meta */}
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-secondary/70">
        <Sparkles className="h-3 w-3 shrink-0 text-neon-cyan" />
        <span className="truncate font-semibold text-text-secondary">{briefing.botName}</span>
        {team && (
          <>
            <span className="text-text-secondary/30">·</span>
            <span className="truncate">{team.name}</span>
          </>
        )}
      </div>
      {/* insight one-liner with ellipsis */}
      <div className="line-clamp-2 text-[12px] leading-snug text-text-primary">
        {briefing.insight}
      </div>
      {/* footer */}
      <div className="mt-auto flex items-center justify-between gap-2 text-[10px] text-text-secondary/70">
        <span className="font-mono tabular-nums">{briefing.date}</span>
        <div className="flex items-center gap-1">
          {proposedCount > 0 && (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">
              {proposedCount} 项
            </span>
          )}
          <ChevronRight className="h-3 w-3 transition-colors group-hover:text-neon-cyan" />
        </div>
      </div>
    </button>
  );
}

// =============================================================
// 今日工作台 sub-block wrapper
// =============================================================

function WorkbenchBlock({
  title,
  count,
  countLabel,
  right,
  children,
}: {
  title: string;
  count: number;
  countLabel: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
          <span className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-deep-black px-2 py-0.5 text-[10px] font-mono uppercase tracking-wide text-text-secondary">
            <span className="text-text-primary">{count}</span>
            <span className="text-text-secondary/60">{countLabel}</span>
          </span>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// =============================================================
// 今日课程 row
// =============================================================

function TodayCourseRow({
  course,
  nextUnit,
  onOpen,
}: {
  course: CourseTrack;
  nextUnit: CourseUnit;
  onOpen: () => void;
}) {
  const pct = Math.round((course.progress ?? 0) * 100);
  return (
    <button
      onClick={onOpen}
      className="group flex items-start gap-3 rounded-xl border border-glass-border bg-deep-black-light px-4 py-3 text-left transition-colors hover:border-neon-purple/40 hover:bg-deep-black-light/80"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-xl">
        {course.coverEmoji}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
          <BookOpen className="h-3 w-3" />
          <span className="truncate">{course.title}</span>
          <span className="text-text-secondary/30">·</span>
          <span className="font-mono tabular-nums text-neon-cyan">{pct}%</span>
        </div>
        <div className="flex items-center gap-1.5 text-[12px] text-text-primary">
          <Play className="h-3 w-3 shrink-0 text-neon-cyan" />
          <span className="font-medium">Unit {nextUnit.index}.</span>
          <span className="truncate text-text-secondary">{nextUnit.title}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-glass-bg">
          <div className="h-full bg-neon-cyan" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 self-center text-text-secondary/60 transition-colors group-hover:text-neon-cyan" />
    </button>
  );
}

// =============================================================
// 进行中任务 row
// =============================================================

function TodayTaskRow({ project }: { project: CentaurProject }) {
  const myTeamId = myTeams().find((t) => project.participants?.includes(t.id))?.id;
  const myTeam = myTeamId ? teamById(myTeamId) : null;
  const otherParticipants = (project.participants ?? []).filter((id) => id !== myTeamId).length;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-400/[0.03] px-4 py-3 transition-colors hover:border-amber-400/40">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-400/40 bg-amber-400/10 text-amber-300">
        <Clock className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide">
          <span className="inline-flex items-center gap-1 rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 font-semibold text-amber-300">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            进行中
          </span>
          <span className="text-text-secondary">{project.sprintWeeks}w sprint</span>
          {myTeam && (
            <>
              <span className="text-text-secondary/30">·</span>
              <span className="text-text-secondary">作为 <span className="font-semibold text-text-primary">{myTeam.name}</span></span>
            </>
          )}
        </div>
        <div className="line-clamp-1 text-[13px] font-semibold text-text-primary">{project.title}</div>
        <div className="flex items-center gap-3 text-[11px] text-text-secondary">
          <span className="flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-emerald-400/70" /> {otherParticipants} 个其他半人马在执行
          </span>
          <span className="text-text-secondary/30">·</span>
          <span className="font-mono text-emerald-300 tabular-nums">${project.budget.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
