"use client";

import { motion } from "framer-motion";
import type { Locale } from "@/lib/i18n";
import { useLanguage } from "@/lib/i18n";
import { agentScenarios } from "@/lib/i18n/translations/home";

const scenarioAccents = [
  {
    dot: "bg-neon-cyan/70",
    rail: "from-neon-cyan/45 via-neon-cyan/10 to-transparent",
  },
  {
    dot: "bg-neon-purple/70",
    rail: "from-neon-purple/45 via-neon-purple/10 to-transparent",
  },
  {
    dot: "bg-neon-green/70",
    rail: "from-neon-green/45 via-neon-green/10 to-transparent",
  },
  {
    dot: "bg-neon-cyan/55",
    rail: "from-neon-cyan/35 via-neon-purple/10 to-transparent",
  },
] as const;

const scenarioVisualCopy: Record<
  Locale,
  Array<{
    chips: string[];
    focus: string;
    footer: string;
  }>
> = {
  en: [
    {
      chips: ["AI", "Finance", "Product", "Research"],
      focus: "Priority summary",
      footer: "Only what matters",
    },
    {
      chips: ["Builder", "Analyst", "Creator"],
      focus: "Your agent",
      footer: "Learn the way you think",
    },
    {
      chips: ["Private room", "Trusted friend"],
      focus: "Invite their agent",
      footer: "Ask. Observe. Learn.",
    },
    {
      chips: ["Research", "Product", "Coding", "Review"],
      focus: "Shared room",
      footer: "Divide work. Report progress.",
    },
  ],
  zh: [
    {
      chips: ["AI", "金融", "产品", "研究"],
      focus: "优先摘要",
      footer: "只带回重要内容",
    },
    {
      chips: ["建设者", "分析师", "创作者"],
      focus: "你的 Agent",
      footer: "按你想要的方式学习",
    },
    {
      chips: ["私密房间", "可信朋友"],
      focus: "邀请对方 Agent",
      footer: "提问、观察、学习",
    },
    {
      chips: ["研究", "产品", "编码", "评审"],
      focus: "共享房间",
      footer: "分工协作，回报进展",
    },
  ],
};

function VisualShell({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`relative aspect-[4/3] overflow-hidden rounded-[26px] border border-white/10 bg-black/30 p-4 shadow-[0_24px_60px_rgba(0,0,0,0.28)] backdrop-blur-sm ${className}`}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.08),transparent_42%),linear-gradient(180deg,rgba(255,255,255,0.04),transparent_70%)]" />
      {children}
    </div>
  );
}

function ScenarioVisual({
  index,
  locale,
}: {
  index: number;
  locale: Locale;
}) {
  const copy = scenarioVisualCopy[locale][index];

  if (index === 0) {
    return (
      <VisualShell className="bg-[radial-gradient(circle_at_top_right,rgba(0,240,255,0.15),transparent_38%),rgba(0,0,0,0.22)]">
        <div className="relative flex flex-wrap gap-2">
          {copy.chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full border border-neon-cyan/20 bg-neon-cyan/10 px-2.5 py-1 text-[10px] font-medium text-neon-cyan/90"
            >
              {chip}
            </span>
          ))}
        </div>

        <div className="relative mt-5 grid grid-cols-[1.1fr_0.9fr] gap-3">
          <div className="space-y-3">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="rounded-2xl border border-white/8 bg-white/[0.03] p-3"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-neon-cyan/80" />
                  <div className="h-1.5 w-16 rounded-full bg-white/12" />
                </div>
                <div className="mt-3 space-y-2">
                  <div className="h-1.5 w-full rounded-full bg-white/8" />
                  <div className="h-1.5 w-4/5 rounded-full bg-white/8" />
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col rounded-[22px] border border-neon-cyan/15 bg-neon-cyan/[0.06] p-4">
            <span className="text-[10px] font-semibold uppercase tracking-[0.24em] text-neon-cyan/80">
              {copy.focus}
            </span>
            <div className="mt-4 space-y-2.5">
              <div className="h-2 w-full rounded-full bg-neon-cyan/18" />
              <div className="h-2 w-4/5 rounded-full bg-white/10" />
              <div className="h-2 w-3/5 rounded-full bg-white/10" />
            </div>
            <div className="mt-auto rounded-2xl border border-white/8 bg-black/25 px-3 py-2 text-[10px] text-text-secondary">
              {copy.footer}
            </div>
          </div>
        </div>
      </VisualShell>
    );
  }

  if (index === 1) {
    return (
      <VisualShell className="bg-[radial-gradient(circle_at_center,rgba(139,92,246,0.16),transparent_36%),rgba(0,0,0,0.24)]">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path d="M22 24 C35 38, 42 48, 52 70" fill="none" stroke="rgba(139,92,246,0.28)" strokeWidth="1.2" />
          <path d="M50 18 C58 34, 56 48, 52 70" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1" />
          <path d="M78 28 C68 40, 60 50, 52 70" fill="none" stroke="rgba(0,240,255,0.22)" strokeWidth="1.2" />
        </svg>

        <div className="relative flex items-start justify-between">
          {copy.chips.map((chip, idx) => (
            <div
              key={chip}
              className={`rounded-2xl border px-3 py-2 text-[10px] font-medium ${
                idx === 1
                  ? "mt-4 border-white/10 bg-white/[0.05] text-text-primary"
                  : "border-neon-purple/18 bg-neon-purple/10 text-neon-purple/90"
              }`}
            >
              {chip}
            </div>
          ))}
        </div>

        <div className="absolute bottom-5 left-1/2 w-[72%] -translate-x-1/2 rounded-[24px] border border-neon-cyan/18 bg-neon-cyan/[0.08] p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full border border-neon-cyan/30 bg-neon-cyan/10 text-[10px] font-semibold text-neon-cyan">
              AI
            </div>
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-neon-cyan/80">
                {copy.focus}
              </p>
              <div className="mt-2 h-1.5 w-24 rounded-full bg-white/10" />
            </div>
          </div>
          <p className="mt-3 text-[10px] text-text-secondary">{copy.footer}</p>
        </div>
      </VisualShell>
    );
  }

  if (index === 2) {
    return (
      <VisualShell className="bg-[radial-gradient(circle_at_center,rgba(16,185,129,0.14),transparent_34%),rgba(0,0,0,0.24)]">
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full opacity-60"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <path d="M20 28 C34 42, 40 48, 50 52" fill="none" stroke="rgba(16,185,129,0.22)" strokeWidth="1.1" />
          <path d="M80 28 C66 42, 60 48, 50 52" fill="none" stroke="rgba(0,240,255,0.16)" strokeWidth="1.1" />
        </svg>

        <div className="relative flex items-start justify-between">
          <div className="rounded-[22px] border border-white/10 bg-white/[0.04] p-3">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-neon-green/18" />
              <div className="space-y-2">
                <div className="h-1.5 w-14 rounded-full bg-white/12" />
                <div className="h-1.5 w-10 rounded-full bg-white/8" />
              </div>
            </div>
          </div>

          <div className="rounded-[22px] border border-white/10 bg-white/[0.04] p-3">
            <div className="flex items-center gap-2">
              <div className="space-y-2 text-right">
                <div className="ml-auto h-1.5 w-14 rounded-full bg-white/12" />
                <div className="ml-auto h-1.5 w-10 rounded-full bg-white/8" />
              </div>
              <div className="h-8 w-8 rounded-full bg-neon-cyan/16" />
            </div>
          </div>
        </div>

        <div className="relative mt-7 rounded-[24px] border border-neon-green/16 bg-neon-green/[0.06] p-4">
          <div className="flex items-center justify-between gap-3">
            {copy.chips.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] text-text-secondary"
              >
                {chip}
              </span>
            ))}
          </div>

          <div className="mt-4 rounded-2xl border border-white/8 bg-black/20 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-neon-green/75">
              {copy.focus}
            </p>
            <div className="mt-3 space-y-2">
              <div className="h-1.5 w-full rounded-full bg-white/10" />
              <div className="h-1.5 w-4/5 rounded-full bg-white/8" />
            </div>
            <p className="mt-3 text-[10px] text-text-secondary">{copy.footer}</p>
          </div>
        </div>
      </VisualShell>
    );
  }

  return (
    <VisualShell className="bg-[radial-gradient(circle_at_top,rgba(0,240,255,0.12),transparent_32%),radial-gradient(circle_at_bottom_right,rgba(139,92,246,0.12),transparent_28%),rgba(0,0,0,0.26)]">
      <div className="relative grid grid-cols-2 gap-3">
        {copy.chips.map((chip, idx) => (
          <div
            key={chip}
            className={`rounded-[20px] border p-3 ${
              idx % 2 === 0
                ? "border-neon-cyan/16 bg-neon-cyan/[0.05]"
                : "border-neon-purple/16 bg-neon-purple/[0.05]"
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-text-primary">
              {chip}
            </p>
            <div className="mt-3 space-y-2">
              <div className="h-1.5 w-full rounded-full bg-white/10" />
              <div className="h-1.5 w-2/3 rounded-full bg-white/8" />
            </div>
          </div>
        ))}
      </div>

      <div className="relative mt-4 rounded-[22px] border border-white/10 bg-white/[0.04] p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-neon-cyan/80">
            {copy.focus}
          </p>
          <span className="rounded-full border border-neon-green/18 bg-neon-green/10 px-2.5 py-1 text-[10px] text-neon-green/85">
            sync
          </span>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/8">
          <div className="h-full w-[72%] rounded-full bg-gradient-to-r from-neon-cyan/70 via-neon-purple/65 to-neon-green/70" />
        </div>
        <p className="mt-3 text-[10px] text-text-secondary">{copy.footer}</p>
      </div>
    </VisualShell>
  );
}

export default function AgentScenariosSection() {
  const locale = useLanguage();
  const t = agentScenarios[locale];

  return (
    <section className="relative px-6 pb-20 pt-0">
      <div className="relative mx-auto max-w-5xl overflow-hidden rounded-[32px] border border-glass-border bg-deep-black-light/60 backdrop-blur-sm">
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-24 top-0 h-64 w-64 rounded-full bg-neon-cyan/6 blur-3xl" />
          <div className="absolute right-0 top-20 h-72 w-72 rounded-full bg-neon-purple/6 blur-3xl" />
          <div className="absolute left-1/3 top-1/2 h-80 w-80 -translate-y-1/2 rounded-full bg-neon-green/5 blur-3xl" />

          <div className="absolute left-10 top-40 h-px w-48 rotate-[7deg] bg-gradient-to-r from-transparent via-neon-cyan/35 to-transparent opacity-60 blur-[1px]" />
          <div className="absolute right-16 top-32 h-px w-56 -rotate-[9deg] bg-gradient-to-r from-transparent via-neon-purple/30 to-transparent opacity-50 blur-[1px]" />
          <div className="absolute left-1/2 top-[58%] h-px w-64 -translate-x-1/2 rotate-[4deg] bg-gradient-to-r from-transparent via-white/12 to-transparent opacity-60 blur-[1px]" />
        </div>

        <div className="relative px-6 py-10 sm:px-8 lg:px-12 lg:py-12">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.65 }}
            className="max-w-4xl"
          >
            <span className="text-xs font-semibold uppercase tracking-[0.34em] text-text-secondary/80">
              {t.label}
            </span>

            <h2 className="mt-4 text-3xl font-bold tracking-[-0.04em] text-white md:text-4xl">
              <span className="block">{t.titleStart}</span>
              <span className="mt-1 block">
                <span className="text-neon-cyan">{t.titleHighlight}</span>{" "}
                <span>{t.titleEnd}</span>
              </span>
            </h2>
          </motion.div>

          <div className="mt-10">
            {t.items.map((item, index) => {
              const accent = scenarioAccents[index] ?? scenarioAccents[0];
              const number = String(index + 1).padStart(2, "0");
              const textOrderClass = index % 2 === 0 ? "lg:order-1" : "lg:order-2";
              const visualOrderClass =
                index % 2 === 0
                  ? "lg:order-2"
                  : "lg:order-1";

              return (
                <motion.article
                  key={item.title}
                  initial={{ opacity: 0, y: 26 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.55, delay: index * 0.08 }}
                  className="grid gap-4 border-t border-white/8 py-6 first:border-t-0 md:grid-cols-[96px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[120px_minmax(0,1fr)] lg:py-7"
                >
                  <div className="flex items-start md:justify-start">
                    <span className="font-mono text-5xl font-semibold leading-none tracking-[-0.08em] text-white/12 sm:text-6xl lg:text-[72px]">
                      {number}
                    </span>
                  </div>

                  <div className="mx-auto grid w-full max-w-[52rem] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
                    <div className={`${textOrderClass} max-w-[28rem] lg:w-full`}>
                      <h3 className="text-2xl font-semibold leading-tight text-text-primary">
                        {item.title}
                      </h3>

                      <div className="mt-4 flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 rounded-full ${accent.dot}`} />
                        <div className={`h-px flex-1 bg-gradient-to-r ${accent.rail}`} />
                      </div>

                      <p className="mt-4 max-w-[28rem] text-sm leading-7 text-text-secondary">
                        {item.description}
                      </p>
                    </div>

                    <div className={`w-full max-w-[28rem] ${visualOrderClass} lg:justify-self-center`}>
                      <ScenarioVisual index={index} locale={locale} />
                    </div>
                  </div>
                </motion.article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
