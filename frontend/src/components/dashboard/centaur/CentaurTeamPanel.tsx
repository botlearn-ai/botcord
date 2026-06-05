"use client";

/**
 * CentaurTeamPanel — replaces "My Bots" as the new top-level tab.
 *
 * Includes a left team-switcher (your personal centaur + joined teams)
 * and inner sub-nav: Dashboard / Profile / Inbox / Bench / Members / My Bots.
 */

import { useMemo, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  Activity,
  Award,
  BarChart3,
  Bot,
  Inbox,
  Loader2,
  Mail,
  Plus,
  Sparkles,
  Star,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import {
  BRIEFINGS,
  PROJECTS,
  type CentaurTeam,
  myTeams,
  teamById,
} from "@/lib/centaur-mock";
import {
  BriefingCard,
  CentaurRadar,
  CentaurStack,
  CredentialChip,
  CtaPill,
  DomainBadge,
  EmptyState,
  MemberTile,
  MetricBar,
  ProjectCard,
  SectionTitle,
  Sparkline,
  StatTile,
  TeamCard,
  domainMeta,
} from "./atoms";

type TeamSubTab = "dashboard" | "profile" | "inbox" | "bench" | "mybots";

const SUB_TABS: { key: TeamSubTab; label: string; icon: React.ReactNode; href: string }[] = [
  { key: "dashboard", label: "Dashboard", icon: <Activity className="h-4 w-4" />, href: "/chats/centaur-team/dashboard" },
  { key: "profile", label: "Profile", icon: <Award className="h-4 w-4" />, href: "/chats/centaur-team/profile" },
  { key: "inbox", label: "Inbox", icon: <Inbox className="h-4 w-4" />, href: "/chats/centaur-team/inbox" },
  { key: "bench", label: "Bench & 测评", icon: <BarChart3 className="h-4 w-4" />, href: "/chats/centaur-team/bench" },
  { key: "mybots", label: "My Bots", icon: <Bot className="h-4 w-4" />, href: "/chats/centaur-team/mybots" },
];

function deriveSubTab(pathname: string): TeamSubTab {
  const parts = pathname.split("/").filter(Boolean);
  const sub = parts[2];
  if (sub === "profile" || sub === "inbox" || sub === "bench" || sub === "mybots") {
    return sub;
  }
  // legacy /members route → fall back to profile
  return "dashboard";
}

export default function CentaurTeamPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const teams = myTeams();
  const [activeTeamId, setActiveTeamId] = useState<string>(teams[0]?.id ?? "team-self-design");
  const team = useMemo(() => teamById(activeTeamId) ?? teams[0], [activeTeamId, teams]);
  const subTab = deriveSubTab(pathname);

  if (!team) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState title="还没有半人马" hint="先创建你的第一个半人马 — 你 + 一组 Bot" />
      </div>
    );
  }

  const activeMeta = domainMeta(team.domain);

  return (
    <div className="flex h-full overflow-hidden bg-deep-black">
      {/* Centaur picker rail — Discord-style narrow column */}
      <aside className="hidden h-full w-[72px] shrink-0 flex-col items-center gap-1.5 border-r border-glass-border bg-deep-black py-3 md:flex">
        <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-text-secondary/60">My Centaurs</div>
        {teams.map((t) => {
          const active = t.id === activeTeamId;
          const meta = domainMeta(t.domain);
          return (
            <button
              key={t.id}
              onClick={() => setActiveTeamId(t.id)}
              className={`group relative flex h-12 w-12 items-center justify-center rounded-xl border text-lg transition-all duration-200 ${
                active
                  ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan shadow-[0_0_18px_rgba(0,240,255,0.18)]"
                  : "border-glass-border bg-glass-bg/30 hover:border-neon-cyan/40 hover:bg-glass-bg"
              }`}
              title={`${t.name} · ${meta.labelEn} · Lv ${t.level}`}
            >
              <span>{meta.emoji}</span>
              {active && (
                <span className="absolute -left-3 top-1/2 h-7 w-1 -translate-y-1/2 rounded-r-full bg-neon-cyan" />
              )}
              <span className="pointer-events-none absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border border-glass-border bg-deep-black px-1 font-mono text-[9px] font-semibold text-text-secondary">
                {t.level}
              </span>
            </button>
          );
        })}
        <button
          onClick={() => alert("Demo: create new centaur")}
          className="mt-1 flex h-12 w-12 items-center justify-center rounded-xl border border-dashed border-glass-border text-text-secondary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
          title="Create new centaur"
        >
          <Plus className="h-4 w-4" />
        </button>
      </aside>

      {/* Sub-nav rail */}
      <aside className="hidden h-full w-56 shrink-0 flex-col border-r border-glass-border bg-deep-black-light md:flex">
        <div className="border-b border-glass-border px-4 py-3">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
            <span>{activeMeta.emoji}</span>
            <span>{activeMeta.labelEn}</span>
            <span className="text-text-secondary/30">·</span>
            <span>Lv {team.level}</span>
          </div>
          <div className="mt-1 truncate text-[14px] font-semibold text-text-primary">{team.name}</div>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-2 py-3">
          {SUB_TABS.map((tab) => {
            const active = subTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => router.push(tab.href)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                  active
                    ? "bg-neon-cyan/10 text-neon-cyan"
                    : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                }`}
              >
                <span className={active ? "text-neon-cyan" : "text-text-secondary/70"}>{tab.icon}</span>
                <span className="font-medium">{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Right pane — sub-tab content */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 py-6 max-md:px-4 max-md:py-4">
          {/* Mobile centaur switcher + sub-nav */}
          <div className="mb-4 md:hidden">
            <div className="-mx-4 flex gap-1 overflow-x-auto border-b border-glass-border bg-deep-black px-4 py-2">
              {teams.map((t) => {
                const active = t.id === activeTeamId;
                const meta = domainMeta(t.domain);
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTeamId(t.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                      active
                        ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan"
                        : "border-glass-border bg-glass-bg/30 text-text-secondary"
                    }`}
                  >
                    <span>{meta.emoji}</span>
                    {t.name}
                  </button>
                );
              })}
            </div>
            <div className="mt-3 -mx-4 flex gap-1 overflow-x-auto border-b border-glass-border bg-deep-black-light px-4 py-2">
              {SUB_TABS.map((tab) => {
                const active = subTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => router.push(tab.href)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                      active ? "border-neon-cyan/60 bg-neon-cyan/10 text-neon-cyan" : "border-glass-border text-text-secondary"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {subTab === "dashboard" && <TeamDashboard team={team} />}
          {subTab === "profile" && <TeamProfile team={team} />}
          {subTab === "inbox" && <TeamInbox team={team} />}
          {subTab === "bench" && <TeamBench team={team} />}
          {subTab === "mybots" && <TeamMyBots team={team} />}
        </div>
      </div>
    </div>
  );
}

// =============================================================
// Sub-tab: Dashboard
// =============================================================

function TeamDashboard({ team }: { team: CentaurTeam }) {
  const briefings = BRIEFINGS.filter((b) => b.teamId === team.id);
  const teamProjects = PROJECTS.filter((p) => p.participants?.includes(team.id) || p.postedByTeamId === team.id);

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-secondary">
            <span>Team Dashboard</span>
            <span className="text-text-secondary/40">·</span>
            <span>{team.name}</span>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-text-primary">{team.name}</h1>
          <p className="mt-1 text-[13px] text-text-secondary">{team.tagline}</p>
        </div>
        <div className="flex items-center gap-2">
          <CtaPill icon={<Sparkles className="h-3.5 w-3.5" />}>Run Bench</CtaPill>
          <CtaPill tone="ghost">Invite member</CtaPill>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Effective Capability" value={team.scores.effectiveCapability} icon={<Sparkles className="h-4 w-4" />} tone="cyan" />
        <StatTile label="Collab Depth" value={team.scores.collabDepth} icon={<Zap className="h-4 w-4" />} tone="purple" />
        <StatTile label="Deliveries" value={team.delivery.completed} delta={`★ ${team.delivery.rating}`} icon={<Star className="h-4 w-4" />} tone="amber" />
        <StatTile label="On-time %" value={`${team.delivery.onTimePct}%`} icon={<TrendingUp className="h-4 w-4" />} tone="green" />
      </div>

      <section>
        <SectionTitle title="本周简报" subtitle="Agent 反哺这个团队 — 等待团队 leader 判断" icon={<Sparkles className="h-4 w-4 text-neon-cyan" />} />
        {briefings.length === 0 ? (
          <EmptyState title="本周还没有简报" hint="等 Agent 给团队 leader 提出新洞察" />
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {briefings.slice(0, 2).map((b) => (
              <BriefingCard key={b.id} briefing={b} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="团队项目" subtitle="本团队发起或参与的 Sprint" icon={<Activity className="h-4 w-4 text-neon-purple" />} />
        {teamProjects.length === 0 ? (
          <EmptyState title="这个团队还没有项目" hint="去 Discover 浏览公开悬赏" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {teamProjects.slice(0, 3).map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="7-day effective_capability trend" icon={<TrendingUp className="h-4 w-4 text-emerald-400" />} />
        <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[12px] text-text-secondary">每日 effective_capability 综合指数</div>
            <div className="font-mono text-base font-bold text-neon-cyan tabular-nums">{team.weeklyTrend.at(-1)}</div>
          </div>
          <div className="mt-3 h-20">
            <Sparkline data={team.weeklyTrend} height={80} />
          </div>
        </div>
      </section>
    </div>
  );
}

// =============================================================
// Sub-tab: Profile
// =============================================================

function TeamProfile({ team }: { team: CentaurTeam }) {
  return (
    <div className="space-y-8">
      <header>
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-secondary">
          <span>Centaur Profile</span>
          <span className="text-text-secondary/40">·</span>
          <DomainBadge domain={team.domain} />
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-text-primary">{team.name}</h1>
        <p className="mt-1 max-w-xl text-[13px] text-text-secondary">{team.tagline}</p>
      </header>

      {/* A/B/C radar + scores */}
      <section className="grid grid-cols-1 gap-6 rounded-2xl border border-glass-border bg-deep-black-light p-6 lg:grid-cols-2">
        <div className="flex items-center justify-center">
          <CentaurRadar agent={team.scores.agentCapability} human={team.scores.humanJudgment} collab={team.scores.collabDepth} size={240} />
        </div>
        <div className="space-y-3">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary/70">三侧能力指数</div>
          <MetricBar label="A · Agent" value={team.scores.agentCapability} tone="cyan" />
          <MetricBar label="B · Human" value={team.scores.humanJudgment} tone="purple" />
          <MetricBar label="C · Collab" value={team.scores.collabDepth} tone="green" />
          <div className="my-2 border-t border-glass-border" />
          <MetricBar label="Effective" value={team.scores.effectiveCapability} tone="amber" />
          <p className="mt-2 text-[11px] leading-relaxed text-text-secondary/80">
            <span className="text-neon-cyan">蓝图公式</span>：有效能力 = min(Agent 能力, 人的想象力)，加上协作深度乘数。
          </p>
        </div>
      </section>

      {/* Credentials */}
      <section>
        <SectionTitle title="Verified Credentials" subtitle="可输出 API 到 Upwork / Fiverr / LinkedIn" icon={<Award className="h-4 w-4 text-amber-400" />} />
        <div className="flex flex-wrap gap-2">
          {team.verifiedCredentials.map((c, i) => (
            <CredentialChip key={i} label={c.label} />
          ))}
        </div>
      </section>

      {/* Services declaration */}
      <section>
        <SectionTitle title="对外服务声明" subtitle="这个半人马能为客户做的事情" icon={<Mail className="h-4 w-4 text-neon-purple" />} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {team.services.map((s, i) => (
            <div key={i} className="rounded-xl border border-glass-border bg-deep-black-light px-4 py-3">
              <div className="text-[13px] font-semibold text-text-primary">{s}</div>
              <div className="mt-1 text-[11px] text-text-secondary">Sprint 制 · 按贡献结算</div>
            </div>
          ))}
        </div>
      </section>

      {/* The centaur — 1 human + N bots */}
      <section>
        <SectionTitle title="Centaur 身份" subtitle="一个半人马 = 一个人 + 1-N 个 Bot — 这是劳动力的最小单位" icon={<Users className="h-4 w-4 text-text-secondary" />} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {team.members.map((m) => (
            <MemberTile key={m.id} member={m} />
          ))}
        </div>
      </section>
    </div>
  );
}

// =============================================================
// Sub-tab: Inbox
// =============================================================

function TeamInbox({ team }: { team: CentaurTeam }) {
  const briefings = BRIEFINGS.filter((b) => b.teamId === team.id);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold text-text-primary">Team Inbox</h1>
        <p className="mt-1 text-[12px] text-text-secondary">
          团队级 INSIGHT 简报 + 通知 — 这里是「Agent 发起 → 人判断响应」的核心翻转入口。
        </p>
      </header>

      <div className="space-y-4">
        {briefings.length === 0 ? (
          <EmptyState title="收件箱是空的" hint="等 Agent 给你一条改变判断的简报" />
        ) : (
          briefings.map((b) => <BriefingCard key={b.id} briefing={b} />)
        )}
      </div>
    </div>
  );
}

// =============================================================
// Sub-tab: Bench
// =============================================================

function TeamBench({ team }: { team: CentaurTeam }) {
  const dimensions = [
    { key: "info_gathering", label: "信息搜集", a: 88, b: 72, max: 100 },
    { key: "judgment_framing", label: "问题框架", a: 76, b: 81, max: 100 },
    { key: "exec_quality", label: "执行质量", a: 92, b: 64, max: 100 },
    { key: "comm_clarity", label: "沟通清晰", a: 80, b: 78, max: 100 },
    { key: "domain_taste", label: "领域品味", a: 70, b: 86, max: 100 },
  ];
  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Bench & 测评</h1>
          <p className="mt-1 text-[12px] text-text-secondary">
            团队级 benchmark — 每个维度都是「Agent 侧 + 人侧」双轨评分，最后落到 effective_capability。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CtaPill icon={<Loader2 className="h-3.5 w-3.5" />}>Run Bench Session</CtaPill>
          <CtaPill tone="ghost">查看历史</CtaPill>
        </div>
      </header>

      <section>
        <SectionTitle title="维度评分（A 侧 / B 侧）" subtitle="对比 Agent 能力 vs 人的判断力 — 找出当前瓶颈" icon={<BarChart3 className="h-4 w-4 text-neon-cyan" />} />
        <div className="space-y-3 rounded-2xl border border-glass-border bg-deep-black-light p-5">
          {dimensions.map((d) => {
            const bottleneck = d.a > d.b + 10 ? "human" : d.b > d.a + 10 ? "agent" : null;
            return (
              <div key={d.key} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="font-semibold uppercase tracking-wide text-text-secondary">{d.label}</span>
                  {bottleneck && (
                    <span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                      bottleneck === "human"
                        ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
                        : "border-rose-400/40 bg-rose-400/10 text-rose-300"
                    }`}>
                      {bottleneck === "human" ? "Human 瓶颈" : "Agent 瓶颈"}
                    </span>
                  )}
                </div>
                <MetricBar label="A · Agent" value={d.a} tone="cyan" />
                <MetricBar label="B · Human" value={d.b} tone="purple" />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionTitle title="月度 Retro 诊断" subtitle="自动找出团队的瓶颈侧 + 提出建议" icon={<TrendingUp className="h-4 w-4 text-emerald-400" />} />
        <div className="rounded-2xl border border-amber-400/30 bg-amber-400/5 p-5">
          <div className="text-[12px] font-semibold uppercase tracking-wider text-amber-300">⚠ 本月瓶颈</div>
          <p className="mt-2 text-[14px] leading-relaxed text-text-primary">
            人的判断力跟不上 Agent 能力提升速度 — Agent 侧领先 16 个点。Agent 学到的「执行质量」和「信息搜集」能力没有被充分利用。
          </p>
          <div className="mt-3 rounded-lg border border-glass-border bg-deep-black/40 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">系统建议</div>
            <p className="mt-1 text-[13px] leading-relaxed text-text-secondary">
              主人在 Volta 的「品牌系统翻译」类目里尝试让 Agent 承担初稿，把人的精力集中在评审环节。
            </p>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle title="Verified Credentials" subtitle="可输出到外部平台" icon={<Award className="h-4 w-4 text-amber-400" />} />
        <div className="flex flex-wrap gap-2">
          {team.verifiedCredentials.map((c, i) => (
            <CredentialChip key={i} label={c.label} />
          ))}
        </div>
      </section>
    </div>
  );
}

// =============================================================
// Sub-tab: My Bots
// =============================================================

function TeamMyBots({ team }: { team: CentaurTeam }) {
  // One centaur = one human + N bots. Just enumerate the bots of this centaur.
  const allBots = useMemo(() => team.members.flatMap((m) => m.bots), [team]);

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">My Bots</h1>
          <p className="mt-1 text-[12px] text-text-secondary">
            你的 {allBots.length} 只 Bot — 半人马的执行单元。这是你这个半人马的全部算力侧资产。
          </p>
        </div>
        <CtaPill icon={<Plus className="h-3.5 w-3.5" />}>Create new Bot</CtaPill>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {allBots.map((b) => (
          <div key={b.id} className="flex items-start gap-3 rounded-2xl border border-glass-border bg-deep-black-light p-4">
            <img src={b.avatar} alt={b.name} className="h-10 w-10 shrink-0 rounded-xl border border-neon-cyan/30 object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-text-primary">{b.name}</div>
              <div className="mt-0.5 inline-flex rounded-md border border-glass-border bg-deep-black px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-text-secondary">
                {b.runtime}
              </div>
              <div className="mt-2 font-mono text-[10px] text-text-secondary/60">{b.id}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
