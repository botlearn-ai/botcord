"use client";

/**
 * SearchPanel — natural-language intent → structured Sprint task spec.
 *
 * Route: /chats/search?q=<query>
 *
 * UX:
 *   1. Top: query echo + back-to-home
 *   2. ~1.5s parsing animation
 *   3. Reveal: task type / complexity / domains / budget / sprint weeks /
 *              collaboration mode / AI summary / deliverables
 *   4. Below: matching centaurs from Market filtered by domain overlap
 *   5. CTAs: 发起 Sprint 任务 (→ /chats/market/tasks) · 调整参数
 */

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Award,
  CheckCircle2,
  ChevronRight,
  Clock,
  Loader2,
  Search,
  Sparkles,
  Target,
  Users,
  Wand2,
} from "lucide-react";
import {
  TEAMS,
  type ParsedIntent,
  parseIntent,
} from "@/lib/centaur-mock";
import {
  CtaPill,
  DomainBadge,
  EmptyState,
  MetricBar,
  SectionTitle,
  TeamCard,
  domainMeta,
} from "./atoms";

const PARSE_DELAY_MS = 1500;

export default function SearchPanel() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const query = searchParams.get("q") || "";
  const [parsed, setParsed] = useState<ParsedIntent | null>(null);

  // Re-parse whenever the query changes (simulate 1.5s LLM call).
  useEffect(() => {
    if (!query) {
      setParsed(null);
      return;
    }
    setParsed(null);
    const timer = setTimeout(() => {
      setParsed(parseIntent(query));
    }, PARSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Matching centaurs: any overlap with parsed domains, sorted by effectiveCapability.
  const matching = useMemo(() => {
    if (!parsed) return [];
    return TEAMS.filter((t) =>
      !t.isOwn && t.domain && parsed.domains.includes(t.domain),
    ).sort((a, b) => b.scores.effectiveCapability - a.scores.effectiveCapability).slice(0, 6);
  }, [parsed]);

  if (!query) {
    return (
      <div className="h-full overflow-y-auto bg-deep-black">
        <div className="mx-auto max-w-3xl px-6 py-16">
          <EmptyState
            title="没有搜索词"
            hint="回 Home 输入你想让半人马帮你做的事"
            icon={<Search className="h-10 w-10" />}
          />
          <div className="mt-4 flex justify-center">
            <CtaPill onClick={() => router.push("/chats/home")}>回到 Home</CtaPill>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-deep-black">
      <div className="mx-auto max-w-5xl px-6 py-6 max-md:px-4 max-md:py-4">
        {/* Back + query echo */}
        <button
          onClick={() => router.push("/chats/home")}
          className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-text-secondary transition-colors hover:text-neon-cyan"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回 Home
        </button>

        <header className="mb-6 rounded-2xl border border-glass-border bg-gradient-to-br from-neon-purple/10 via-deep-black-light to-neon-cyan/10 px-5 py-4">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-text-secondary">
            <Wand2 className="h-3.5 w-3.5 text-neon-purple" />
            <span>意图搜索</span>
          </div>
          <p className="mt-2 text-[15px] leading-relaxed text-text-primary">
            「<span className="font-semibold">{query}</span>」
          </p>
        </header>

        {!parsed ? <ParsingState /> : <ParsedResult parsed={parsed} matching={matching} />}
      </div>
    </div>
  );
}

// =============================================================
// Parsing animation (~1.5s)
// =============================================================

function ParsingState() {
  // Animate "steps" reveal — 3 fake stages
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 400);
    const t2 = setTimeout(() => setStep(2), 900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);
  const stages = [
    "理解你的话…",
    "识别任务类型与领域…",
    "估算复杂度与预算区间…",
  ];
  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light p-8">
      <div className="flex items-center gap-3 text-neon-cyan">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-[14px] font-semibold">AI 正在解析意图…</span>
      </div>
      <div className="mt-4 space-y-2">
        {stages.map((s, i) => {
          const active = step >= i;
          const done = step > i;
          return (
            <div key={i} className="flex items-center gap-2 text-[12px]">
              {done ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              ) : active ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-neon-cyan" />
              ) : (
                <span className="h-4 w-4 shrink-0 rounded-full border border-glass-border" />
              )}
              <span className={done ? "text-text-secondary line-through" : active ? "text-text-primary" : "text-text-secondary/50"}>
                {s}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================
// Parsed result
// =============================================================

function ParsedResult({ parsed, matching }: { parsed: ParsedIntent; matching: typeof TEAMS }) {
  const router = useRouter();
  return (
    <div className="space-y-8">
      {/* AI summary */}
      <section className="rounded-2xl border border-neon-cyan/30 bg-neon-cyan/5 p-5">
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-neon-cyan">
          <Sparkles className="h-3 w-3" /> AI 解析结果
        </div>
        <p className="mt-2 text-[14px] leading-relaxed text-text-primary">{parsed.summary}</p>
      </section>

      {/* Structured spec */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Left column */}
        <div className="space-y-4">
          <SpecRow label="任务类型" mono={parsed.taskTypeEn}>
            <span className="text-[14px] font-semibold text-text-primary">{parsed.taskType}</span>
          </SpecRow>

          <SpecRow label="预估复杂度">
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xl font-bold text-neon-cyan tabular-nums">Lv {parsed.level}</span>
              <span className="text-[11px] text-text-secondary">/ 5</span>
            </div>
            <div className="mt-2">
              <MetricBar label="Complexity" value={parsed.level * 20} tone="cyan" />
            </div>
          </SpecRow>

          <SpecRow label="协作模式">
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                parsed.collaboration === "multi-centaur"
                  ? "border-neon-purple/40 bg-neon-purple/10 text-neon-purple"
                  : "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
              }`}>
                {parsed.collaboration === "multi-centaur" ? <Users className="h-3 w-3" /> : <Target className="h-3 w-3" />}
                {parsed.collaboration === "multi-centaur" ? "多半人马协同" : "单半人马独立"}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
              {parsed.collaboration === "multi-centaur"
                ? "建议走能力众筹协议 — 让多个领域的半人马质押能力加入 Sprint。"
                : "一个领域专精半人马就能交付，不需要跨域。"}
            </p>
          </SpecRow>
        </div>

        {/* Right column */}
        <div className="space-y-4">
          <SpecRow label="涉及领域">
            <div className="flex flex-wrap gap-1.5">
              {parsed.domains.map((d) => (
                <DomainBadge key={d} domain={d} size="md" />
              ))}
            </div>
          </SpecRow>

          <SpecRow label="建议预算区间">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold text-emerald-300 tabular-nums">
                ${parsed.budget.low.toLocaleString()}
              </span>
              <span className="text-text-secondary/60">—</span>
              <span className="font-mono text-2xl font-bold text-emerald-300 tabular-nums">
                ${parsed.budget.high.toLocaleString()}
              </span>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-text-secondary">
              按蓝图能力众筹协议的「Lv × 单位定价」推算
            </p>
          </SpecRow>

          <SpecRow label="Sprint 周期">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-300" />
              <span className="text-[16px] font-semibold text-text-primary">{parsed.sprintWeeks} 周</span>
            </div>
          </SpecRow>
        </div>
      </section>

      {/* Deliverables */}
      <section>
        <SectionTitle title="🎯 AI 拆出的交付物" subtitle="发起 Sprint 时可直接复用为里程碑" icon={<CheckCircle2 className="h-4 w-4 text-emerald-400" />} />
        <div className="space-y-2 rounded-2xl border border-glass-border bg-deep-black-light p-4">
          {parsed.deliverables.map((d, i) => (
            <div key={i} className="flex items-start gap-2.5 rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2">
              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-neon-cyan/40 bg-neon-cyan/10 font-mono text-[10px] font-bold text-neon-cyan">
                {i + 1}
              </div>
              <span className="text-[13px] text-text-primary">{d}</span>
            </div>
          ))}
        </div>
      </section>

      {/* CTAs */}
      <section className="flex flex-wrap items-center gap-2 rounded-2xl border border-glass-border bg-glass-bg/20 p-4">
        <CtaPill tone="cyan" icon={<Sparkles className="h-3.5 w-3.5" />} onClick={() => router.push("/chats/market/tasks")}>
          发起 Sprint 任务
        </CtaPill>
        <CtaPill tone="ghost">调整参数</CtaPill>
        <span className="ml-auto text-[11px] text-text-secondary">
          确认无误后，AI 会自动起草任务声明并提交到 Task Market
        </span>
      </section>

      {/* Matching centaurs */}
      <section>
        <SectionTitle
          title="🦄 匹配到的半人马"
          subtitle={`基于领域 + effective_capability 排序 — ${matching.length} 个最佳候选`}
          icon={<Users className="h-4 w-4 text-neon-purple" />}
          right={
            <CtaPill tone="ghost" onClick={() => router.push("/chats/market/centaurs")}>
              更多 Centaur Market
            </CtaPill>
          }
        />
        {matching.length === 0 ? (
          <EmptyState title="暂无匹配的半人马" hint="试试改一下措辞，让 AI 重新解析" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {matching.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// =============================================================
// SpecRow — 一行结构化字段
// =============================================================

function SpecRow({ label, mono, children }: { label: string; mono?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary/70">{label}</div>
        {mono && <span className="font-mono text-[10px] text-text-secondary/50">{mono}</span>}
      </div>
      <div className="mt-2">{children}</div>
    </div>
  );
}
