"use client";

/**
 * UniversityPanel — 半人马大学 / Centaur University.
 *
 * Maps to BotLearn blueprint v4.0 Onboarding Layer (人机共学课程).
 * Each course is a track of double-track units (人类理解轨 + Agent 执行轨
 * + 对齐 Checkpoint). Completing a unit produces an alignment_score —
 * the first quantitative signal of the human's judgement.
 *
 * Routes:
 *   /chats/university             -> default → courses landing
 *   /chats/university/courses     -> courses landing (my learning + KOL + catalog)
 *   /chats/university/skill-hunt  -> skill marketplace (migrated from Market)
 *   /chats/university/<slug>      -> course detail (any non-tab path treated as slug)
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  AlertTriangle,
  Award,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronLeft,
  Clock,
  Copy,
  Cpu,
  Eye,
  Filter,
  Flame,
  GraduationCap,
  Lock,
  Play,
  RefreshCw,
  ScrollText,
  Sparkles,
  Star,
  Target,
  Terminal,
  TrendingUp,
  Unlock,
  Users,
} from "lucide-react";
import {
  COURSE_TRACKS,
  type CentaurDomain,
  type CourseTrack,
  type CourseUnit,
  SKILLS,
  courseTrackBySlug,
  myCourseTracks,
  myLearningSummary,
  teamById,
  unitsByTrack,
} from "@/lib/centaur-mock";
import {
  CtaPill,
  DomainBadge,
  DomainTabs,
  EmptyState,
  MetricBar,
  SectionTitle,
  SkillCard,
  StatTile,
  domainMeta,
} from "./atoms";

type UniversitySubTab = "courses" | "skill-hunt";

function deriveRoute(pathname: string): { mode: "landing"; tab: UniversitySubTab } | { mode: "course"; slug: string } {
  const parts = pathname.split("/").filter(Boolean);
  const part = parts[2];
  if (!part) return { mode: "landing", tab: "courses" };
  if (part === "courses") return { mode: "landing", tab: "courses" };
  if (part === "skill-hunt") return { mode: "landing", tab: "skill-hunt" };
  // any other slug is treated as a course slug → detail page
  return { mode: "course", slug: part };
}

export default function UniversityPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const route = deriveRoute(pathname);

  // Top-of-panel header + sub-nav stays consistent across landing modes.
  const isCourseDetail = route.mode === "course";

  return (
    <div className="h-full overflow-y-auto bg-deep-black">
      <div className="mx-auto max-w-6xl px-6 py-6 max-md:px-4 max-md:py-4">
        {!isCourseDetail && (
          <>
            <header className="mb-5 flex items-center justify-between gap-4 rounded-2xl border border-glass-border bg-gradient-to-r from-neon-purple/8 via-deep-black-light to-neon-cyan/8 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-neon-purple/40 bg-neon-purple/10 text-neon-purple">
                  <GraduationCap className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-xl font-semibold text-text-primary">半人马大学</h1>
                  <p className="mt-0.5 text-[12px] text-text-secondary">
                    Courses + Skill Hunt — 人机共学 + 技能装载，让你和你的半人马持续进化
                  </p>
                </div>
              </div>
              <CtaPill tone="purple" icon={<Sparkles className="h-3.5 w-3.5" />}>
                KOL 共建入口
              </CtaPill>
            </header>

            <div className="mb-6 flex flex-wrap gap-1.5 border-b border-glass-border pb-3">
              {([
                { key: "courses", label: "Courses", icon: <BookOpen className="h-4 w-4" /> },
                { key: "skill-hunt", label: "Skill Hunt", icon: <Sparkles className="h-4 w-4" /> },
              ] as const).map((tab) => {
                const active = route.mode === "landing" && route.tab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => router.push(`/chats/university/${tab.key}`)}
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
          </>
        )}

        {route.mode === "landing" && route.tab === "courses" && <CoursesLanding />}
        {route.mode === "landing" && route.tab === "skill-hunt" && <SkillHunt />}
        {route.mode === "course" && <CourseDetail slug={route.slug} />}
      </div>
    </div>
  );
}

// =============================================================
// Landing
// =============================================================

function CoursesLanding() {
  const router = useRouter();
  const summary = myLearningSummary();
  const myCourses = myCourseTracks();
  const [domain, setDomain] = useState<CentaurDomain | "all">("all");
  const [level, setLevel] = useState<"all" | CourseTrack["level"]>("all");

  const catalog = useMemo(() => {
    return COURSE_TRACKS.filter((c) => {
      if (domain !== "all" && c.domain !== domain) return false;
      if (level !== "all" && c.level !== level) return false;
      return true;
    });
  }, [domain, level]);

  const kolPicks = COURSE_TRACKS.filter((c) => c.badge === "kol-pick").slice(0, 3);

  return (
    <div className="space-y-10">
      {/* My Learning */}
      <section>
        <SectionTitle
          title="我的学习"
          subtitle="本月 alignment_score 走势 — 你的判断力第一个可量化指标"
          icon={<Target className="h-4 w-4 text-neon-cyan" />}
        />
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile
            label="Alignment Score"
            value={summary.alignmentScore}
            delta={<span className="text-emerald-400">↑ 6 vs last week</span>}
            icon={<Target className="h-4 w-4" />}
            tone="cyan"
          />
          <StatTile
            label="Units Completed"
            value={`${summary.unitsCompleted} / ${summary.unitsTotal}`}
            delta={`across ${summary.enrolledCount} courses`}
            icon={<CheckCircle2 className="h-4 w-4" />}
            tone="green"
          />
          <StatTile
            label="Streak"
            value={`${summary.streakDays} d`}
            delta="never miss a daily unit"
            icon={<Flame className="h-4 w-4" />}
            tone="amber"
          />
          <StatTile
            label="Enrolled Courses"
            value={summary.enrolledCount}
            delta="2 in progress · 0 待 unlock"
            icon={<BookOpen className="h-4 w-4" />}
            tone="purple"
          />
        </div>

        {/* In-progress courses */}
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {myCourses.map((course) => (
            <CourseProgressCard key={course.id} course={course} onOpen={() => router.push(`/chats/university/${course.slug}`)} />
          ))}
        </div>
      </section>

      {/* KOL Picks */}
      <section>
        <SectionTitle
          title="🦄 KOL 共建课"
          subtitle="Market 里的领头半人马把自家工作流编入课程"
          icon={<Users className="h-4 w-4 text-neon-purple" />}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {kolPicks.map((course) => (
            <CourseCard key={course.id} course={course} onOpen={() => router.push(`/chats/university/${course.slug}`)} />
          ))}
        </div>
      </section>

      {/* Full catalog */}
      <section>
        <SectionTitle
          title="所有课程"
          subtitle="按领域 / 难度筛选"
          icon={<Filter className="h-4 w-4 text-text-secondary" />}
          right={
            <span className="text-[11px] text-text-secondary">{catalog.length} courses</span>
          }
        />
        <div className="mb-4 space-y-3">
          <DomainTabs value={domain} onChange={setDomain} />
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-wide text-text-secondary/60">Level</span>
            {(["all", "beginner", "intermediate", "advanced"] as const).map((lv) => {
              const active = level === lv;
              const label = lv === "all" ? "All" : lv === "beginner" ? "Beginner" : lv === "intermediate" ? "Intermediate" : "Advanced";
              return (
                <button
                  key={lv}
                  onClick={() => setLevel(lv)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                    active
                      ? "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan"
                      : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/30 hover:text-text-primary"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {catalog.length === 0 ? (
          <EmptyState title="暂无符合条件的课程" hint="试试改变筛选条件" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {catalog.map((course) => (
              <CourseCard key={course.id} course={course} onOpen={() => router.push(`/chats/university/${course.slug}`)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// =============================================================
// Skill Hunt — Skill marketplace (migrated from MarketPanel)
// =============================================================

function SkillHunt() {
  const [domain, setDomain] = useState<CentaurDomain | "all">("all");
  const [price, setPrice] = useState<"all" | "free" | "premium">("all");

  const filtered = useMemo(() => {
    return SKILLS.filter((s) => {
      if (domain !== "all" && s.category !== domain) return false;
      if (price !== "all" && s.price !== price) return false;
      return true;
    });
  }, [domain, price]);

  const hot = SKILLS.filter((s) => s.badge === "hot").slice(0, 3);

  return (
    <div className="space-y-10">
      <section>
        <SectionTitle
          title="🛠 Skill Hunt"
          subtitle="为你的半人马挑选 Skill — 安装即扩展某个 Bot 的能力。Skill 是 Agent 的执行力插件。"
          icon={<Sparkles className="h-4 w-4 text-neon-cyan" />}
        />
      </section>

      <section>
        <SectionTitle title="🔥 Hot Skills" subtitle="本周热度最高的 3 个 Skill" icon={<Flame className="h-4 w-4 text-rose-400" />} />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hot.map((s) => (
            <SkillCard key={s.id} skill={s} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle title="All Skills" subtitle="按领域 / 价格筛选" icon={<Filter className="h-4 w-4 text-text-secondary" />} />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <DomainTabs value={domain} onChange={setDomain} />
          <div className="flex items-center gap-1.5 border-l border-glass-border pl-3">
            {(["all", "free", "premium"] as const).map((p) => {
              const active = price === p;
              const label = p === "all" ? "All" : p === "free" ? "Free" : "Premium";
              return (
                <button
                  key={p}
                  onClick={() => setPrice(p)}
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
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-glass-border bg-deep-black-light/40 px-6 py-10 text-center text-[12px] text-text-secondary">
            暂无符合条件的 Skill
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((s) => (
              <SkillCard key={s.id} skill={s} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// =============================================================
// Cards
// =============================================================

function CourseProgressCard({ course, onOpen }: { course: CourseTrack; onOpen: () => void }) {
  const units = unitsByTrack(course.slug);
  const completed = units.filter((u) => u.completed).length;
  const nextUnit = units.find((u) => u.unlocked && !u.completed);
  const meta = course.domain !== "general" ? domainMeta(course.domain) : null;
  return (
    <button
      onClick={onOpen}
      className="group flex flex-col gap-3 rounded-2xl border border-neon-cyan/30 bg-deep-black-light p-5 text-left transition-all hover:-translate-y-0.5 hover:border-neon-cyan/60 hover:shadow-[0_8px_30px_rgba(0,240,255,0.1)]"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-2xl">
          {course.coverEmoji}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/80">
            {meta ? <DomainBadge domain={course.domain as CentaurDomain} /> : (
              <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
            )}
            <span className="text-text-secondary/30">·</span>
            <span>{course.level}</span>
          </div>
          <h3 className="mt-1 line-clamp-2 text-[14px] font-semibold leading-snug text-text-primary group-hover:text-neon-cyan">
            {course.title}
          </h3>
        </div>
      </div>

      <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{course.tagline}</p>

      <div>
        <div className="flex items-center justify-between text-[11px] text-text-secondary">
          <span>{completed} / {units.length} units</span>
          <span className="font-mono text-neon-cyan tabular-nums">{Math.round((course.progress ?? 0) * 100)}%</span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-glass-bg">
          <div className="h-full bg-neon-cyan" style={{ width: `${Math.round((course.progress ?? 0) * 100)}%` }} />
        </div>
      </div>

      {nextUnit && (
        <div className="rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-[12px]">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neon-cyan">
            <Play className="h-3 w-3" /> Next
          </div>
          <div className="mt-0.5 line-clamp-1 text-text-primary">{nextUnit.index}. {nextUnit.title}</div>
        </div>
      )}
    </button>
  );
}

function CourseCard({ course, onOpen }: { course: CourseTrack; onOpen: () => void }) {
  const author = course.author;
  const team = author.teamId ? teamById(author.teamId) : null;
  const meta = course.domain !== "general" ? domainMeta(course.domain) : null;
  const units = unitsByTrack(course.slug);
  const badge =
    course.badge === "core" ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neon-cyan">
        <Sparkles className="h-2.5 w-2.5" /> Core
      </span>
    ) : course.badge === "new" ? (
      <span className="inline-flex items-center rounded-md border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300">
        New
      </span>
    ) : course.badge === "kol-pick" ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-neon-purple/40 bg-neon-purple/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neon-purple">
        🦄 KOL Pick
      </span>
    ) : null;

  return (
    <button
      onClick={onOpen}
      className="group flex h-full flex-col gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all hover:-translate-y-0.5 hover:border-neon-purple/40 hover:shadow-[0_8px_30px_rgba(139,92,246,0.08)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-xl">
          {course.coverEmoji}
        </div>
        {badge}
      </div>

      <div>
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/80">
          {meta ? <DomainBadge domain={course.domain as CentaurDomain} /> : (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
          )}
          <span className="text-text-secondary/30">·</span>
          <span>{course.level}</span>
        </div>
        <h3 className="mt-1 line-clamp-2 text-[14px] font-semibold leading-snug text-text-primary group-hover:text-text-primary">
          {course.title}
        </h3>
      </div>

      <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{course.tagline}</p>

      <div className="mt-auto space-y-2 border-t border-glass-border pt-3">
        <div className="flex items-center gap-2 text-[11px] text-text-secondary">
          <span className="font-medium text-text-primary">by {author.name}</span>
          {team && (
            <>
              <span className="text-text-secondary/40">·</span>
              <span className="truncate text-text-secondary">{team.name}</span>
            </>
          )}
        </div>
        <div className="flex items-center justify-between text-[11px] text-text-secondary">
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <BookOpen className="h-3 w-3" /> {units.length} units
            </span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {course.durationMinutes}m
            </span>
          </span>
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            <span className="font-semibold text-text-primary tabular-nums">{course.rating}</span>
          </span>
        </div>
      </div>
    </button>
  );
}

// =============================================================
// Course detail (dual-track units)
// =============================================================

function CourseDetail({ slug }: { slug: string }) {
  const router = useRouter();
  const course = courseTrackBySlug(slug);
  const units = unitsByTrack(slug);
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null);

  if (!course) {
    return (
      <div className="py-12">
        <button
          onClick={() => router.push("/chats/university")}
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-text-secondary transition-colors hover:text-neon-cyan"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> 返回大学
        </button>
        <EmptyState title="课程不存在" hint="可能已下架" />
      </div>
    );
  }

  const team = course.author.teamId ? teamById(course.author.teamId) : null;
  const completed = units.filter((u) => u.completed).length;
  const meta = course.domain !== "general" ? domainMeta(course.domain) : null;
  const activeUnit = units.find((u) => u.id === activeUnitId) || units.find((u) => u.unlocked && !u.completed) || units[0];

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push("/chats/university")}
        className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary transition-colors hover:text-neon-cyan"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> 返回大学
      </button>

      {/* Course header */}
      <header className="overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light">
        <div className="flex items-start gap-5 p-5">
          <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl border border-glass-border bg-glass-bg text-5xl">
            {course.coverEmoji}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary">
              {meta ? <DomainBadge domain={course.domain as CentaurDomain} /> : (
                <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
              )}
              <span className="text-text-secondary/30">·</span>
              <span>{course.level}</span>
              <span className="text-text-secondary/30">·</span>
              <span>{course.durationMinutes}m</span>
              <span className="text-text-secondary/30">·</span>
              <span>{units.length} units</span>
            </div>
            <h1 className="mt-2 text-2xl font-semibold leading-snug text-text-primary">{course.title}</h1>
            <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{course.tagline}</p>
            <div className="mt-3 flex items-center gap-3 text-[12px]">
              <div className="flex items-center gap-1.5">
                <span className="text-text-secondary/60">by</span>
                <span className="font-semibold text-text-primary">{course.author.name}</span>
                {team && (
                  <span className="text-text-secondary">· {team.name}</span>
                )}
              </div>
              <span className="text-text-secondary/30">·</span>
              <span className="flex items-center gap-1 text-text-secondary">
                <Users className="h-3 w-3" /> {course.enrolled.toLocaleString()} enrolled
              </span>
              <span className="text-text-secondary/30">·</span>
              <span className="flex items-center gap-1 text-text-secondary">
                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                <span className="font-semibold text-text-primary">{course.rating}</span>
              </span>
            </div>
          </div>
          <div className="flex shrink-0 flex-col gap-2">
            {course.enrolledByMe ? (
              <CtaPill icon={<Play className="h-3.5 w-3.5" />}>Continue · {Math.round((course.progress ?? 0) * 100)}%</CtaPill>
            ) : (
              <CtaPill tone="purple" icon={<Sparkles className="h-3.5 w-3.5" />}>Enroll</CtaPill>
            )}
            <CtaPill tone="ghost">Share</CtaPill>
          </div>
        </div>

        {course.enrolledByMe && (
          <div className="border-t border-glass-border bg-glass-bg/20 px-5 py-3">
            <div className="flex items-center justify-between text-[11px] text-text-secondary">
              <span>进度: {completed} / {units.length} units done</span>
              <span className="font-mono text-neon-cyan tabular-nums">{Math.round((course.progress ?? 0) * 100)}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-deep-black">
              <div className="h-full bg-neon-cyan" style={{ width: `${Math.round((course.progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
      </header>

      {/* Two-column: unit list + active unit detail */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_1fr]">
        {/* Unit list */}
        <aside className="rounded-2xl border border-glass-border bg-deep-black-light p-3">
          <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">Units</div>
          <ol className="space-y-1">
            {units.map((u) => (
              <li key={u.id}>
                <UnitListRow
                  unit={u}
                  active={u.id === activeUnit?.id}
                  onClick={() => setActiveUnitId(u.id)}
                />
              </li>
            ))}
          </ol>
        </aside>

        {/* Active unit detail */}
        <div>
          {activeUnit ? <UnitDetail unit={activeUnit} /> : (
            <EmptyState title="选择一个单元" hint="左侧列表选一个单元开始" />
          )}
        </div>
      </div>
    </div>
  );
}

function UnitListRow({ unit, active, onClick }: { unit: CourseUnit; active: boolean; onClick: () => void }) {
  const lockedClass = !unit.unlocked
    ? "border-glass-border bg-glass-bg/20 text-text-secondary/60"
    : active
    ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
    : "border-glass-border bg-glass-bg/40 text-text-secondary hover:border-neon-cyan/40 hover:text-text-primary";

  const icon = !unit.unlocked ? (
    <Lock className="h-3 w-3" />
  ) : unit.completed ? (
    <CheckCircle2 className="h-3 w-3 text-emerald-400" />
  ) : (
    <Play className="h-3 w-3" />
  );

  return (
    <button
      onClick={onClick}
      disabled={!unit.unlocked}
      className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed ${lockedClass}`}
    >
      <span className="mt-0.5">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[9px] uppercase tracking-wide opacity-70">
          <span>Unit {unit.index}</span>
          {unit.alignmentScore != null && (
            <>
              <span className="opacity-40">·</span>
              <span className="font-mono">{Math.round(unit.alignmentScore * 100)}</span>
            </>
          )}
        </div>
        <div className="mt-0.5 line-clamp-2 text-[12px] font-medium">{unit.title}</div>
      </div>
    </button>
  );
}

function UnitDetail({ unit }: { unit: CourseUnit }) {
  // Gate state — must fill both critical correction + optimization instruction.
  const [critique, setCritique] = useState("");
  const [revision, setRevision] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const canSubmit = critique.trim().length >= 12 && revision.trim().length >= 12;

  // Reset gate when switching units
  useEffect(() => {
    setCritique("");
    setRevision("");
    setSubmitted(false);
  }, [unit.id]);

  return (
    <article className="space-y-5">
      {/* Unit header */}
      <header className="rounded-2xl border border-glass-border bg-deep-black-light p-5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
          <span>Unit {unit.index}</span>
          <span className="text-text-secondary/30">·</span>
          {unit.completed ? (
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> Completed · alignment {Math.round((unit.alignmentScore ?? 0) * 100)}
            </span>
          ) : unit.unlocked ? (
            <span className="text-neon-cyan">In progress · 双轨学习中</span>
          ) : (
            <span className="inline-flex items-center gap-1 text-text-secondary">
              <Lock className="h-3 w-3" /> 完成上一单元才能解锁
            </span>
          )}
        </div>
        <h2 className="mt-2 text-xl font-semibold leading-snug text-text-primary">{unit.title}</h2>
        {/* 触发情境 inline */}
        <p className="mt-3 border-l-2 border-amber-400/40 pl-3 text-[12px] italic leading-relaxed text-text-secondary">
          {unit.scenario}
        </p>
      </header>

      {/* DUAL-SCREEN: 人类轨 ↔ Agent 轨 */}
      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* LEFT — Human Track (练脑) */}
        <HumanTrackPanel unit={unit} />
        {/* RIGHT — Agent Sandbox (练手) */}
        <AgentSandboxPanel unit={unit} />
      </section>

      {/* 交汇点 · 通关挑战 */}
      <ConvergenceGate
        unit={unit}
        critique={critique}
        setCritique={setCritique}
        revision={revision}
        setRevision={setRevision}
        canSubmit={canSubmit}
        submitted={submitted}
        onSubmit={() => setSubmitted(true)}
      />

      {/* alignment_score reveal */}
      {(submitted || unit.completed) && (
        <div className="rounded-2xl border border-emerald-400/30 bg-emerald-400/5 p-4">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
            <Award className="h-3 w-3" /> 通关 · alignment_score
          </div>
          <div className="mt-2">
            <MetricBar
              label="本单元 alignment"
              value={Math.round((unit.alignmentScore ?? (submitted ? 0.74 : 0)) * 100)}
              tone="green"
            />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
            这个分数会喂给你的 Centaur Profile B 侧（人判断力）— 不是「你答对了」，是「你识别 Agent 漏洞的精度 × 给出优化指令的清晰度」。
          </p>
        </div>
      )}
    </article>
  );
}

// =============================================================
// LEFT — Human Track (练脑)
// =============================================================

function HumanTrackPanel({ unit }: { unit: CourseUnit }) {
  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-neon-purple/30 bg-gradient-to-b from-neon-purple/8 to-deep-black-light p-5">
      <header className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neon-purple">
            <Brain className="h-3.5 w-3.5" /> 人类轨 · 练脑
          </div>
          <div className="mt-0.5 text-[10px] text-text-secondary">建立判断标准 / 拔高品味，不是传递操作步骤</div>
        </div>
        <ScrollText className="h-4 w-4 shrink-0 text-neon-purple/50" />
      </header>

      <div>
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">业务逻辑</div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-text-primary">{unit.humanTrack}</p>
      </div>

      {unit.humanFramework && unit.humanFramework.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">思维框架</div>
          <ol className="mt-2 space-y-2">
            {unit.humanFramework.map((f, i) => (
              <li key={i} className="flex items-start gap-2.5 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2 text-[12px] leading-relaxed text-text-primary">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-neon-purple/40 bg-neon-purple/10 font-mono text-[10px] font-bold text-neon-purple">
                  {i + 1}
                </span>
                {f}
              </li>
            ))}
          </ol>
        </div>
      )}

      {unit.humanCriteria && unit.humanCriteria.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">
            <Eye className="h-3 w-3" /> 评判标准（用来审查右侧 Agent 初稿）
          </div>
          <ul className="mt-2 space-y-1.5">
            {unit.humanCriteria.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed text-text-secondary">
                <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neon-purple" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// =============================================================
// RIGHT — Agent Sandbox (练手) with streaming output
// =============================================================

function AgentSandboxPanel({ unit }: { unit: CourseUnit }) {
  const prompt = unit.agentPrompt ?? `请帮我完成: ${unit.title}`;
  const fullOutput = unit.agentOutput ?? unit.agentTrack;
  const [runId, setRunId] = useState(0);

  const { text: streamedText, done } = useTypewriter(fullOutput, runId);

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-neon-cyan/30 bg-gradient-to-b from-neon-cyan/8 to-deep-black-light p-5">
      <header className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-neon-cyan">
            <Cpu className="h-3.5 w-3.5" /> Agent 轨 · 练手
          </div>
          <div className="mt-0.5 text-[10px] text-text-secondary">真实 AI 沙盒 / 实时运行 / 暴露机器边界</div>
        </div>
        <button
          onClick={() => setRunId((id) => id + 1)}
          className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg/40 px-2 py-1 text-[10px] font-medium text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
          title="Re-run"
        >
          <RefreshCw className={`h-3 w-3 ${!done ? "animate-spin" : ""}`} />
          Re-run
        </button>
      </header>

      {/* Sandbox card */}
      <div className="overflow-hidden rounded-xl border border-glass-border bg-deep-black">
        {/* Terminal-style title bar */}
        <div className="flex items-center justify-between gap-2 border-b border-glass-border bg-glass-bg/30 px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-400/60" />
            <span className="h-2 w-2 rounded-full bg-amber-400/60" />
            <span className="h-2 w-2 rounded-full bg-emerald-400/60" />
          </div>
          <div className="flex items-center gap-1 font-mono text-[10px] text-text-secondary/70">
            <Terminal className="h-3 w-3" />
            agent-sandbox · run #{runId + 1}
          </div>
          <button
            onClick={() => navigator?.clipboard?.writeText(fullOutput).catch(() => {})}
            className="text-text-secondary/60 hover:text-text-secondary"
            title="Copy output"
          >
            <Copy className="h-3 w-3" />
          </button>
        </div>

        {/* Prompt */}
        <div className="border-b border-glass-border px-3 py-2">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-text-secondary/60">prompt</div>
          <p className="mt-0.5 font-mono text-[11px] leading-relaxed text-text-secondary">{prompt}</p>
        </div>

        {/* Output (streaming) */}
        <div className="px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-wider text-neon-cyan">
            output
            {!done && (
              <span className="flex items-center gap-1 text-text-secondary">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neon-cyan" />
                streaming…
              </span>
            )}
          </div>
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-text-primary">
            {streamedText}
            {!done && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-neon-cyan align-middle" />}
          </pre>
        </div>
      </div>

      {unit.agentBlindSpots && unit.agentBlindSpots.length > 0 && done && (
        <details className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[11px]">
          <summary className="flex cursor-pointer items-center gap-1.5 font-semibold text-amber-300">
            <AlertTriangle className="h-3 w-3" />
            盲点 hint（{unit.agentBlindSpots.length} 个等你审查）
          </summary>
          <ul className="mt-2 space-y-1">
            {unit.agentBlindSpots.map((b, i) => (
              <li key={i} className="text-text-secondary">— {b}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

// =============================================================
// 交汇点通关 gate
// =============================================================

function ConvergenceGate({
  unit,
  critique,
  setCritique,
  revision,
  setRevision,
  canSubmit,
  submitted,
  onSubmit,
}: {
  unit: CourseUnit;
  critique: string;
  setCritique: (v: string) => void;
  revision: string;
  setRevision: (v: string) => void;
  canSubmit: boolean;
  submitted: boolean;
  onSubmit: () => void;
}) {
  return (
    <section className="rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-400/8 to-deep-black-light p-5">
      <header className="flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
            <Target className="h-3.5 w-3.5" /> 交汇点 · 人机认知对齐
          </div>
          <div className="mt-0.5 text-[11px] text-text-secondary">
            必须使用左侧的思维框架 + 评判标准，审查右侧 Agent 初稿 — 不能被动听课
          </div>
        </div>
        <div className="text-[10px] font-mono uppercase tracking-wider text-text-secondary/60">
          {submitted ? "ALIGNED ✓" : canSubmit ? "READY" : "LOCKED"}
        </div>
      </header>

      <div className="mt-4 space-y-3">
        <GateField
          label="① Agent 初稿的逻辑漏洞 / 遗漏的盲点"
          hint={unit.checkpoint.promptAgentMissed}
          value={critique}
          onChange={setCritique}
          disabled={submitted}
          minLen={12}
          icon={<Eye className="h-3.5 w-3.5" />}
        />
        <GateField
          label="② 你的优化指令（让 Agent 重做时怎么写 prompt）"
          hint={unit.checkpoint.promptRevisedInstruction}
          value={revision}
          onChange={setRevision}
          disabled={submitted}
          minLen={12}
          icon={<Sparkles className="h-3.5 w-3.5" />}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-emerald-400/20 pt-3">
        <div className="text-[11px] text-text-secondary">
          {submitted ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-400">
              <Unlock className="h-3 w-3" /> 已通过认知对齐 — 下一单元已解锁
            </span>
          ) : canSubmit ? (
            <span className="text-emerald-300">两项均已填写 — 可以提交</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Lock className="h-3 w-3" /> 两项都需要 ≥ 12 字符的具体回答
            </span>
          )}
        </div>
        <button
          onClick={onSubmit}
          disabled={!canSubmit || submitted}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] font-semibold transition-all ${
            submitted
              ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300"
              : canSubmit
              ? "border-emerald-400/60 bg-emerald-400/15 text-emerald-300 hover:bg-emerald-400/25"
              : "cursor-not-allowed border-glass-border bg-glass-bg/30 text-text-secondary/50"
          }`}
        >
          {submitted ? (
            <>
              <CheckCircle2 className="h-3.5 w-3.5" /> 已通关
            </>
          ) : (
            <>
              <Unlock className="h-3.5 w-3.5" /> 提交并解锁下一单元
            </>
          )}
        </button>
      </div>
    </section>
  );
}

function GateField({
  label,
  hint,
  value,
  onChange,
  disabled,
  minLen,
  icon,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  minLen: number;
  icon?: React.ReactNode;
}) {
  const ok = value.trim().length >= minLen;
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
        {icon}
        {label}
        {value.length > 0 && (
          <span className={`ml-auto font-mono text-[10px] ${ok ? "text-emerald-400" : "text-amber-300"}`}>
            {value.length} {ok ? "✓" : `/ ≥ ${minLen}`}
          </span>
        )}
      </div>
      <textarea
        placeholder={hint}
        rows={2}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-none rounded-lg border border-glass-border bg-deep-black px-3 py-2 text-[12px] text-text-primary placeholder:text-text-secondary/50 focus:border-emerald-400/60 focus:outline-none disabled:opacity-60"
      />
    </div>
  );
}

// =============================================================
// useTypewriter — char-by-char streaming simulation
// =============================================================

function useTypewriter(full: string, runKey: number, speed = 8) {
  const [text, setText] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setText("");
    setDone(false);
    if (!full) {
      setDone(true);
      return;
    }
    let i = 0;
    const id = setInterval(() => {
      i += Math.max(1, Math.floor(full.length / 400));
      if (i >= full.length) {
        setText(full);
        setDone(true);
        clearInterval(id);
        return;
      }
      setText(full.slice(0, i));
    }, speed);
    return () => clearInterval(id);
  }, [full, runKey, speed]);
  return { text, done };
}
