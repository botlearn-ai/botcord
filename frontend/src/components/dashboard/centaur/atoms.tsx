"use client";

/**
 * Shared atoms for the Centaur demo surface.
 *
 * All components are presentational and read from centaur-mock.ts fixtures.
 * Keep them small and composable — they are used across Home / CentaurTeam / Discover.
 */

import { useMemo } from "react";
import type { ReactNode } from "react";
import {
  Award,
  CheckCircle2,
  ChevronRight,
  Clock,
  Download,
  Flame,
  MessageCircle,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  DOMAINS,
  type Briefing,
  type CentaurDomain,
  type CentaurProject,
  type CentaurSkill,
  type CentaurTeam,
  type CommunityPost,
  type LeaderboardEntry,
  teamById,
} from "@/lib/centaur-mock";
import { initialsFromName } from "../roomVisualTheme";

// =============================================================
// Tiny helpers
// =============================================================

export const domainMeta = (d: CentaurDomain) => DOMAINS.find((x) => x.key === d)!;

export function DomainBadge({ domain, size = "sm" }: { domain: CentaurDomain; size?: "sm" | "md" }) {
  const meta = domainMeta(domain);
  const px = size === "md" ? "px-2.5 py-1 text-[11px]" : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass-bg ${px} font-medium uppercase tracking-wide text-text-secondary`}
    >
      <span>{meta.emoji}</span>
      <span>{meta.labelEn}</span>
    </span>
  );
}

export function MetricBar({
  label,
  value,
  tone = "cyan",
}: {
  label: string;
  value: number;
  tone?: "cyan" | "purple" | "green" | "amber";
}) {
  const colorClass =
    tone === "purple"
      ? "bg-neon-purple"
      : tone === "green"
      ? "bg-emerald-400"
      : tone === "amber"
      ? "bg-amber-400"
      : "bg-neon-cyan";
  return (
    <div className="flex items-center gap-3">
      <span className="w-28 shrink-0 text-[11px] uppercase tracking-wide text-text-secondary/70">{label}</span>
      <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-glass-bg">
        <div className={`absolute inset-y-0 left-0 ${colorClass}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-semibold text-text-primary tabular-nums">{value}</span>
    </div>
  );
}

export function Sparkline({ data, tone = "cyan", height = 40 }: { data: number[]; tone?: "cyan" | "purple" | "green"; height?: number }) {
  const { points, fill } = useMemo(() => {
    const max = Math.max(...data, 1);
    const min = Math.min(...data, 0);
    const range = Math.max(max - min, 1);
    const w = 120;
    const h = height;
    const step = w / Math.max(1, data.length - 1);
    const coords = data.map((v, i) => {
      const x = i * step;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return [x, y] as const;
    });
    const path = coords.map(([x, y], i) => (i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`)).join(" ");
    const fillPath = `${path} L ${w} ${h} L 0 ${h} Z`;
    return { points: path, fill: fillPath };
  }, [data, height]);
  const color = tone === "purple" ? "#a78bfa" : tone === "green" ? "#34d399" : "#22d3ee";
  return (
    <svg viewBox={`0 0 120 ${height}`} className="h-10 w-full" preserveAspectRatio="none">
      <path d={fill} fill={color} opacity="0.12" />
      <path d={points} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// =============================================================
// Team card
// =============================================================

export function TeamCard({
  team,
  onClick,
  variant = "default",
}: {
  team: CentaurTeam;
  onClick?: () => void;
  variant?: "default" | "compact" | "row";
}) {
  const meta = domainMeta(team.domain);

  if (variant === "row") {
    return (
      <button
        onClick={onClick}
        className="group flex w-full items-center gap-4 rounded-xl border border-glass-border bg-deep-black-light px-4 py-3 text-left transition-colors hover:border-neon-cyan/40 hover:bg-glass-bg"
      >
        <CentaurStack members={team.members} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">{team.name}</span>
            <DomainBadge domain={team.domain} />
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary/70">Lv {team.level}</span>
          </div>
          <p className="mt-0.5 truncate text-[12px] text-text-secondary">{team.tagline}</p>
        </div>
        <div className="hidden shrink-0 items-center gap-4 sm:flex">
          <div className="text-right">
            <div className="text-sm font-semibold text-neon-cyan tabular-nums">{team.scores.effectiveCapability}</div>
            <div className="text-[10px] uppercase tracking-wide text-text-secondary/60">Effective</div>
          </div>
          <div className="text-right">
            <div className="flex items-center gap-1 text-sm font-semibold text-text-primary tabular-nums">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" /> {team.delivery.rating}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-text-secondary/60">{team.delivery.completed} deliveries</div>
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary/60 transition-colors group-hover:text-neon-cyan" />
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="group flex h-full flex-col gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-neon-cyan/40 hover:shadow-[0_8px_30px_rgba(0,240,255,0.08)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-lg">
            {meta.emoji}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-primary">{team.name}</div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
              <span>{meta.labelEn}</span>
              <span className="text-text-secondary/30">·</span>
              <span>Lv {team.level}</span>
            </div>
          </div>
        </div>
      </div>

      <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{team.tagline}</p>

      <div className="flex items-center gap-3">
        <CentaurStack members={team.members} size="sm" />
        <div className="text-[10px] uppercase tracking-wide text-text-secondary/70">
          {team.members[0]?.human.name} · {team.members.reduce((acc, m) => acc + m.bots.length, 0)} bots
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-glass-border pt-3">
        <div className="flex items-center gap-3 text-[11px] text-text-secondary">
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            <span className="font-semibold text-text-primary">{team.delivery.rating}</span>
          </span>
          <span>·</span>
          <span>{team.delivery.completed} deliveries</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] font-semibold text-neon-cyan">
          <Sparkles className="h-3 w-3" />
          <span className="tabular-nums">{team.scores.effectiveCapability}</span>
        </div>
      </div>
    </button>
  );
}

// =============================================================
// Avatar stack (human + bots)
// =============================================================

export function CentaurStack({ members, size = "md" }: { members: CentaurTeam["members"]; size?: "sm" | "md" | "lg" }) {
  const sz = size === "sm" ? "h-6 w-6 text-[9px]" : size === "lg" ? "h-10 w-10 text-xs" : "h-8 w-8 text-[10px]";
  const ring = "ring-2 ring-deep-black-light";
  const max = 4;
  const visible = members.slice(0, max);
  const overflow = members.length - max;
  return (
    <div className="flex items-center -space-x-2">
      {visible.map((member, idx) => (
        <div
          key={member.id}
          className={`${sz} ${ring} relative flex shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 font-semibold text-neon-green`}
          style={{ zIndex: 10 - idx }}
          title={member.human.name}
        >
          {initialsFromName(member.human.name)}
        </div>
      ))}
      {overflow > 0 && (
        <div className={`${sz} ${ring} relative flex shrink-0 items-center justify-center rounded-full border border-glass-border bg-glass-bg font-semibold text-text-secondary`}>
          +{overflow}
        </div>
      )}
    </div>
  );
}

// =============================================================
// Briefing card (INSIGHT daily brief)
// =============================================================

export function BriefingCard({ briefing, onAction }: { briefing: Briefing; onAction?: (id: string, action: "approve" | "reject" | "snooze") => void }) {
  const team = teamById(briefing.teamId);
  return (
    <div className="overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light">
      <div className="flex items-center justify-between border-b border-glass-border bg-glass-bg/30 px-4 py-2">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-text-secondary">
          <Sparkles className="h-3.5 w-3.5 text-neon-cyan" />
          <span className="font-semibold text-neon-cyan">INSIGHT</span>
          <span className="text-text-secondary/40">·</span>
          <span>{briefing.botName}</span>
          <span className="text-text-secondary/40">·</span>
          <span>{team?.name}</span>
        </div>
        <span className="text-[10px] tabular-nums text-text-secondary/60">{briefing.date}</span>
      </div>

      <div className="space-y-3 p-4">
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">🧠 我观察到</div>
          <p className="text-[13px] leading-relaxed text-text-secondary">{briefing.observed}</p>
        </div>
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">🔗 关联到你的</div>
          <p className="text-[13px] leading-relaxed text-text-secondary">{briefing.connected}</p>
        </div>
        <div className="space-y-1.5 rounded-xl border border-neon-cyan/30 bg-neon-cyan/5 p-3">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-neon-cyan">💡 这会改变你的判断吗？</div>
          <p className="text-[13px] leading-relaxed text-text-primary">{briefing.insight}</p>
        </div>

        {briefing.applied && (
          <div className="space-y-1.5 rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-3">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
              <CheckCircle2 className="h-3 w-3" /> 我已经做了
            </div>
            <p className="text-[13px] leading-relaxed text-text-secondary">{briefing.applied}</p>
          </div>
        )}

        {briefing.proposed && briefing.proposed.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">📌 需要你判断</div>
            {briefing.proposed.map((p, i) => (
              <div key={i} className="rounded-xl border border-glass-border bg-glass-bg/40 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold text-text-primary">{p.title}</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-text-secondary">{p.description}</div>
                  </div>
                  <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                    p.effort === "low"
                      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-400"
                      : p.effort === "medium"
                      ? "border-amber-400/40 bg-amber-400/10 text-amber-400"
                      : "border-rose-400/40 bg-rose-400/10 text-rose-400"
                  }`}>
                    {p.effort}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {briefing.status === "pending" && (
        <div className="flex items-center justify-end gap-2 border-t border-glass-border bg-glass-bg/20 px-4 py-2.5">
          <button
            onClick={() => onAction?.(briefing.id, "snooze")}
            className="rounded-lg border border-glass-border px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            Skip
          </button>
          <button
            onClick={() => onAction?.(briefing.id, "reject")}
            className="rounded-lg border border-rose-400/40 px-3 py-1.5 text-[11px] font-medium text-rose-300 transition-colors hover:bg-rose-400/10"
          >
            Reject
          </button>
          <button
            onClick={() => onAction?.(briefing.id, "approve")}
            className="rounded-lg border border-neon-cyan/60 bg-neon-cyan/15 px-3 py-1.5 text-[11px] font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25"
          >
            Approve · Copy prompt
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================
// Project card
// =============================================================

export function ProjectCard({ project }: { project: CentaurProject }) {
  const team = teamById(project.postedByTeamId);
  const statusBadge =
    project.status === "open" ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-rose-400/40 bg-rose-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-300">
        <span className="h-1.5 w-1.5 rounded-full bg-rose-400" /> 悬赏中
      </span>
    ) : project.status === "in_progress" ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
        <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> 进行中
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
        <CheckCircle2 className="h-3 w-3" /> 已完成
      </span>
    );

  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-cyan/30">
      <div className="flex items-center justify-between gap-3">
        {statusBadge}
        {project.status === "open" && project.deadlineDays != null && (
          <span className="inline-flex items-center gap-1 text-[10px] text-text-secondary">
            <Clock className="h-3 w-3" /> 还有 {project.deadlineDays} 天
          </span>
        )}
      </div>

      <h3 className="line-clamp-2 text-[13px] font-semibold leading-snug text-text-primary">{project.title}</h3>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{project.description}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        {project.domains.map((d) => (
          <DomainBadge key={d} domain={d} />
        ))}
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-glass-border pt-3 text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-emerald-300 tabular-nums">${project.budget.toLocaleString()}</span>
          <span className="text-text-secondary/40">·</span>
          <span className="text-text-secondary">{project.sprintWeeks}w sprint</span>
        </div>
        {project.status === "open" ? (
          <span className="text-text-secondary">
            <span className="font-semibold text-text-primary">{project.stakedTeams.length}</span> 队质押 · {project.interestedTeams} 感兴趣
          </span>
        ) : project.status === "in_progress" ? (
          <span className="text-text-secondary">
            <span className="font-semibold text-text-primary">{project.participants?.length}</span> 队执行中
          </span>
        ) : (
          <span className="flex items-center gap-1 text-text-secondary">
            <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
            <span className="font-semibold text-text-primary tabular-nums">{project.completionRating?.toFixed(1)}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/60">
        <span>Posted by</span>
        <span className="font-medium text-text-secondary">{team?.name ?? "?"}</span>
      </div>
    </div>
  );
}

// =============================================================
// Skill card
// =============================================================

export function SkillCard({ skill }: { skill: CentaurSkill }) {
  const badge =
    skill.badge === "hot" ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-rose-400/40 bg-rose-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-300">
        <Flame className="h-2.5 w-2.5" /> Hot
      </span>
    ) : skill.badge === "new" ? (
      <span className="inline-flex items-center rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-neon-cyan">
        New
      </span>
    ) : skill.badge === "verified" ? (
      <span className="inline-flex items-center gap-1 rounded-md border border-emerald-400/40 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
        <CheckCircle2 className="h-2.5 w-2.5" /> Verified
      </span>
    ) : null;
  return (
    <div className="flex h-full flex-col gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4 transition-colors hover:border-neon-purple/40">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[13px] font-semibold text-text-primary">{skill.name}</div>
          <div className="mt-0.5 text-[11px] text-text-secondary">by {skill.author.name}</div>
        </div>
        {badge}
      </div>
      <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{skill.description}</p>
      <div className="flex flex-wrap gap-1">
        {skill.tags.slice(0, 4).map((tag) => (
          <span key={tag} className="rounded-md border border-glass-border bg-glass-bg/40 px-1.5 py-0.5 font-mono text-[9px] text-text-secondary">
            #{tag}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-glass-border pt-3 text-[11px]">
        <div className="flex items-center gap-2 text-text-secondary">
          <Download className="h-3 w-3" />
          <span className="font-semibold text-text-primary tabular-nums">{skill.installs.toLocaleString()}</span>
          <span className="text-text-secondary/40">·</span>
          <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
          <span className="font-semibold text-text-primary tabular-nums">{skill.rating}</span>
        </div>
        <button
          className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            skill.price === "free"
              ? "border border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan hover:bg-neon-cyan/25"
              : "border border-neon-purple/60 bg-neon-purple/15 text-neon-purple hover:bg-neon-purple/25"
          }`}
        >
          {skill.price === "free" ? "Install" : "Subscribe"}
        </button>
      </div>
    </div>
  );
}

// =============================================================
// Community post row
// =============================================================

export function PostRow({ post }: { post: CommunityPost }) {
  const team = teamById(post.authorTeamId);
  const meta = post.channel !== "general" ? domainMeta(post.channel as CentaurDomain) : null;
  return (
    <div className="group flex items-start gap-3 rounded-xl border border-glass-border bg-deep-black-light px-4 py-3 transition-colors hover:border-neon-cyan/30">
      <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 rounded-lg border border-glass-border bg-glass-bg/40 px-1 py-1.5">
        <TrendingUp className="h-3 w-3 text-neon-cyan" />
        <span className="text-[11px] font-semibold tabular-nums text-text-primary">{post.upvotes}</span>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-text-secondary/70">
          {meta ? (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">
              {meta.emoji} {meta.labelEn}
            </span>
          ) : (
            <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-0.5 font-semibold text-text-secondary">General</span>
          )}
          <span>·</span>
          <span>{team?.name}</span>
          <span>·</span>
          <span>{post.postedAt}</span>
        </div>
        <h4 className="text-[13px] font-semibold leading-snug text-text-primary group-hover:text-neon-cyan">{post.title}</h4>
        <p className="line-clamp-2 text-[12px] leading-relaxed text-text-secondary">{post.excerpt}</p>
        <div className="flex items-center gap-3 pt-1 text-[11px] text-text-secondary/70">
          <span className="flex items-center gap-1">
            <MessageCircle className="h-3 w-3" /> {post.comments}
          </span>
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Leaderboard row
// =============================================================

export function LeaderboardRow({ entry }: { entry: LeaderboardEntry }) {
  const team = teamById(entry.teamId);
  if (!team) return null;
  const meta = domainMeta(team.domain);
  const deltaNode = entry.delta === 0 ? (
    <span className="text-[10px] text-text-secondary/60">—</span>
  ) : entry.delta > 0 ? (
    <span className="flex items-center gap-0.5 text-[11px] font-semibold text-emerald-400">
      <TrendingUp className="h-3 w-3" /> {entry.delta}
    </span>
  ) : (
    <span className="flex items-center gap-0.5 text-[11px] font-semibold text-rose-400">
      <TrendingDown className="h-3 w-3" /> {Math.abs(entry.delta)}
    </span>
  );
  const rankBadge =
    entry.rank === 1
      ? "border-amber-400/60 bg-amber-400/15 text-amber-300"
      : entry.rank === 2
      ? "border-slate-300/60 bg-slate-300/15 text-slate-200"
      : entry.rank === 3
      ? "border-orange-400/60 bg-orange-400/15 text-orange-300"
      : "border-glass-border bg-glass-bg text-text-secondary";

  return (
    <div className="flex items-center gap-4 rounded-xl border border-glass-border bg-deep-black-light px-4 py-3 transition-colors hover:border-neon-cyan/30">
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border font-mono text-sm font-bold tabular-nums ${rankBadge}`}>
        {entry.rank}
      </div>
      <div className="w-8 shrink-0">{deltaNode}</div>
      <CentaurStack members={team.members} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <span className="truncate">{team.name}</span>
          <DomainBadge domain={team.domain} />
        </div>
        <div className="mt-0.5 text-[11px] text-text-secondary">{team.tagline}</div>
      </div>
      <div className="hidden text-right sm:block">
        <div className="font-mono text-lg font-bold text-neon-cyan tabular-nums">{team.scores.effectiveCapability}</div>
        <div className="text-[10px] uppercase tracking-wide text-text-secondary/60">Effective</div>
      </div>
      <ChevronRight className="hidden h-4 w-4 text-text-secondary/60 sm:block" />
    </div>
  );
}

// =============================================================
// Page header
// =============================================================

export function PageHeader({
  title,
  subtitle,
  icon,
  right,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-glass-border pb-5">
      <div className="flex items-center gap-3">
        {icon && (
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-neon-cyan">
            {icon}
          </div>
        )}
        <div>
          <h1 className="text-xl font-semibold text-text-primary">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[12px] text-text-secondary">{subtitle}</p>}
        </div>
      </div>
      {right && <div className="flex items-center gap-2">{right}</div>}
    </div>
  );
}

// =============================================================
// Domain tab strip
// =============================================================

export function DomainTabs({
  value,
  onChange,
  includeAll = true,
}: {
  value: CentaurDomain | "all";
  onChange: (v: CentaurDomain | "all") => void;
  includeAll?: boolean;
}) {
  const all: ({ key: "all"; labelZh: string; labelEn: string; emoji: string }
    | (typeof DOMAINS)[number])[] = includeAll
    ? [{ key: "all", labelZh: "全部", labelEn: "All", emoji: "✨" }, ...DOMAINS]
    : [...DOMAINS];

  return (
    <div className="flex flex-wrap gap-1.5">
      {all.map((d) => {
        const active = value === d.key;
        return (
          <button
            key={d.key}
            onClick={() => onChange(d.key as CentaurDomain | "all")}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium uppercase tracking-wide transition-colors ${
              active
                ? "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan"
                : "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/30 hover:text-text-primary"
            }`}
          >
            <span>{d.emoji}</span>
            <span>{d.labelEn}</span>
          </button>
        );
      })}
    </div>
  );
}

// =============================================================
// Credentials chip
// =============================================================

export function CredentialChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-400/5 px-2.5 py-1 text-[11px] font-medium text-amber-200">
      <Award className="h-3 w-3 text-amber-400" /> {label}
    </span>
  );
}

// =============================================================
// Stat tile
// =============================================================

export function StatTile({
  label,
  value,
  delta,
  icon,
  tone = "cyan",
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  icon?: ReactNode;
  tone?: "cyan" | "purple" | "green" | "amber";
}) {
  const toneClass =
    tone === "purple"
      ? "text-neon-purple"
      : tone === "green"
      ? "text-emerald-400"
      : tone === "amber"
      ? "text-amber-300"
      : "text-neon-cyan";
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-glass-border bg-deep-black-light p-4">
      <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wide text-text-secondary/70">
        <span>{label}</span>
        {icon && <span className={toneClass}>{icon}</span>}
      </div>
      <div className={`font-mono text-2xl font-bold tabular-nums ${toneClass}`}>{value}</div>
      {delta && <div className="text-[11px] text-text-secondary">{delta}</div>}
    </div>
  );
}

// =============================================================
// Mini radar (A/B/C 三侧)
// =============================================================

export function CentaurRadar({
  agent,
  human,
  collab,
  size = 180,
}: {
  agent: number;
  human: number;
  collab: number;
  size?: number;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 18;
  const angle = (deg: number) => ((deg - 90) * Math.PI) / 180;
  const point = (value: number, deg: number) => {
    const v = value / 100;
    return [cx + Math.cos(angle(deg)) * r * v, cy + Math.sin(angle(deg)) * r * v];
  };
  const [ax, ay] = point(agent, 0);
  const [hx, hy] = point(human, 120);
  const [cx2, cy2] = point(collab, 240);
  const grid = [0.25, 0.5, 0.75, 1];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {grid.map((g) => (
        <polygon
          key={g}
          points={[
            [cx + Math.cos(angle(0)) * r * g, cy + Math.sin(angle(0)) * r * g],
            [cx + Math.cos(angle(120)) * r * g, cy + Math.sin(angle(120)) * r * g],
            [cx + Math.cos(angle(240)) * r * g, cy + Math.sin(angle(240)) * r * g],
          ]
            .map((p) => p.join(","))
            .join(" ")}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="1"
        />
      ))}
      <line x1={cx} y1={cy} x2={cx + Math.cos(angle(0)) * r} y2={cy + Math.sin(angle(0)) * r} stroke="rgba(255,255,255,0.06)" />
      <line x1={cx} y1={cy} x2={cx + Math.cos(angle(120)) * r} y2={cy + Math.sin(angle(120)) * r} stroke="rgba(255,255,255,0.06)" />
      <line x1={cx} y1={cy} x2={cx + Math.cos(angle(240)) * r} y2={cy + Math.sin(angle(240)) * r} stroke="rgba(255,255,255,0.06)" />
      <polygon points={`${ax},${ay} ${hx},${hy} ${cx2},${cy2}`} fill="rgba(0,240,255,0.18)" stroke="#22d3ee" strokeWidth="1.5" />
      <circle cx={ax} cy={ay} r="3" fill="#22d3ee" />
      <circle cx={hx} cy={hy} r="3" fill="#a78bfa" />
      <circle cx={cx2} cy={cy2} r="3" fill="#34d399" />
      <text x={cx + Math.cos(angle(0)) * (r + 12)} y={cy + Math.sin(angle(0)) * (r + 12)} textAnchor="middle" className="fill-text-secondary" fontSize="9">
        A · Agent
      </text>
      <text x={cx + Math.cos(angle(120)) * (r + 12)} y={cy + Math.sin(angle(120)) * (r + 12)} textAnchor="middle" className="fill-text-secondary" fontSize="9">
        B · Human
      </text>
      <text x={cx + Math.cos(angle(240)) * (r + 12)} y={cy + Math.sin(angle(240)) * (r + 12)} textAnchor="middle" className="fill-text-secondary" fontSize="9">
        C · Collab
      </text>
    </svg>
  );
}

// =============================================================
// Member tile
// =============================================================

export function MemberTile({ member }: { member: CentaurTeam["members"][number] }) {
  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 text-sm font-semibold text-neon-green">
          {initialsFromName(member.human.name)}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-primary">{member.human.name}</div>
          <div className="truncate text-[11px] text-text-secondary">{member.human.title}</div>
          <div className="mt-0.5 font-mono text-[10px] text-text-secondary/70">@{member.human.handle}</div>
        </div>
      </div>
      <div className="mt-4 space-y-1.5 border-t border-glass-border pt-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">+ {member.bots.length} bots</div>
        {member.bots.map((bot) => (
          <div key={bot.id} className="flex items-center justify-between gap-2 rounded-lg border border-glass-border bg-glass-bg/30 px-2.5 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <img src={bot.avatar} alt={bot.name} className="h-5 w-5 shrink-0 rounded-md border border-neon-cyan/30 object-cover" />
              <span className="truncate text-[12px] font-medium text-text-primary">{bot.name}</span>
            </div>
            <span className="shrink-0 rounded-md border border-glass-border bg-deep-black px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-secondary">
              {bot.runtime}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================
// Section header (Home)
// =============================================================

export function SectionTitle({ title, subtitle, right, icon }: { title: string; subtitle?: string; right?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-text-primary">
          {icon}
          {title}
        </h2>
        {subtitle && <p className="mt-0.5 text-[11px] text-text-secondary">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

// =============================================================
// CTA pill
// =============================================================

export function CtaPill({ children, onClick, tone = "cyan", icon }: { children: ReactNode; onClick?: () => void; tone?: "cyan" | "purple" | "ghost"; icon?: ReactNode }) {
  const cls =
    tone === "purple"
      ? "border-neon-purple/60 bg-neon-purple/15 text-neon-purple hover:bg-neon-purple/25"
      : tone === "ghost"
      ? "border-glass-border bg-glass-bg/30 text-text-secondary hover:border-neon-cyan/40 hover:text-neon-cyan"
      : "border-neon-cyan/60 bg-neon-cyan/15 text-neon-cyan hover:bg-neon-cyan/25";
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors ${cls}`}
    >
      {icon}
      {children}
    </button>
  );
}

// =============================================================
// Empty state
// =============================================================

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-6 py-12 text-center">
      {icon && <div className="text-text-secondary/40">{icon}</div>}
      <div className="text-sm font-medium text-text-primary">{title}</div>
      {hint && <div className="max-w-sm text-[11px] text-text-secondary">{hint}</div>}
    </div>
  );
}

// =============================================================
// Members icon proxy
// =============================================================

export const CentaurUsersIcon = Users;
