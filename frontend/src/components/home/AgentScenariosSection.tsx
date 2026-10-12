"use client";

import Avatar from "@/components/ui/Avatar";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { motion } from "framer-motion";
import type { Locale } from "@/lib/i18n";
import { useLanguage } from "@/lib/i18n";
import { agentScenarios } from "@/lib/i18n/translations/home";

const scenarioVisualCopy: Record<
  Locale,
  Array<{
    chips: string[];
    focus: string;
    footer: string;
  }> > = {
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

/** `flow` visuals lay out in normal flow, so they may grow taller than 4:3 on narrow screens. */
function VisualShell({ children, flow = false }: { children: React.ReactNode; flow?: boolean }) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] p-4 ${
        flow ? "sm:aspect-[4/3]" : "aspect-[4/3]"
      }`} >
      {children}
    </div>
  );
}

function Bar({ className = "", strong = false }: { className?: string; strong?: boolean }) {
  return (
    <div
      className={`h-1.5 rounded-full ${strong ? "bg-[var(--bc-border-strong)]" : "bg-[var(--bc-border)]"} ${className}`}
    />
  );
}

/** Logo-style cords (VI §5): horizontal-tangent cubics with round caps, drawn in a 0–100 box. */
function Cords({ paths, accentIndex }: { paths: string[]; accentIndex?: number }) {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      fill="none"
      aria-hidden="true" >
      {paths.map((d, i) => (
        <path
          key={d}
          d={d}
          stroke={i === accentIndex ? "var(--bc-brand)" : "var(--bc-border-strong)"}
          strokeWidth={2}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

const panel = "rounded-lg border border-[var(--bc-border)] bg-[var(--bc-surface)]";
const accentCaption = "text-xs font-medium text-[var(--bc-accent-text)]";

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
      <VisualShell flow>
        <div className="relative flex flex-wrap gap-2">
          {copy.chips.map((chip) => (
            <Badge tone="neutral"
              key={chip} >
              {chip}
            </Badge>
          ))}
        </div>

        <div className="relative mt-4 grid grid-cols-[1.1fr_0.9fr] gap-3">
          <div className="space-y-2.5">
            {[0, 1, 2].map((row) => (
              <div key={row} className={`${panel} p-3`}>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[var(--bc-text-tertiary)]" />
                  <Bar strong className="w-16" />
                </div>
                <div className="mt-2.5 space-y-2">
                  <Bar className="w-full" />
                  <Bar className="w-4/5" />
                </div>
              </div>
            ))}
          </div>

          <div className={`${panel} flex flex-col p-4`}>
            <span className={accentCaption}>{copy.focus}</span>
            <div className="mt-4 space-y-2.5">
              <div className="h-2 w-full rounded-full bg-[var(--bc-accent-soft)]" />
              <Bar className="w-4/5" />
              <Bar className="w-3/5" />
            </div>
            <div className="mt-auto rounded-md bg-[var(--bc-surface-sunken)] px-3 py-2 text-xs text-[var(--bc-text-secondary)]">
              {copy.footer}
            </div>
          </div>
        </div>
      </VisualShell>
    );
  }

  if (index === 1) {
    const rows = ["22", "50", "78"];
    return (
      <VisualShell>
        <Cords
          paths={rows.map((y) => `M38 ${y} C 48 ${y}, 48 50, 58 50`)}
          accentIndex={1}
        />
        {copy.chips.map((chip, idx) => (
          <div
            key={chip}
            className={`${panel} absolute left-[4%] w-[34%] -translate-y-1/2 px-3 py-2 text-xs font-medium text-[var(--bc-text)]`}
            style={{ top: `${rows[idx] ?? 50}%` }} >
            {chip}
          </div>
        ))}

        <div className={`${panel} absolute left-[58%] top-1/2 w-[38%] -translate-y-1/2 p-3`}>
          <div className="flex items-center gap-2">
            <Avatar kind="agent" id="scenario-personal-agent" name="AI" size="sm" status="online" />
            <span className={accentCaption}>{copy.focus}</span>
          </div>
          <p className="mt-2.5 text-xs text-[var(--bc-text-secondary)]">{copy.footer}</p>
        </div>
      </VisualShell>
    );
  }

  if (index === 2) {
    return (
      <VisualShell>
        <Cords
          paths={["M26 30 C 31 30, 31 50, 36 50", "M64 50 C 69 50, 69 70, 74 70"]}
          accentIndex={0}
        />
        <div className={`${panel} absolute left-[4%] top-[30%] w-[22%] -translate-y-1/2 p-2.5`}>
          <div className="flex items-center gap-2">
            <Avatar kind="agent" id="scenario-sender" name="Agent" size="sm" />
            <div className="hidden w-full space-y-1.5 sm:block">
              <Bar strong className="w-full" />
              <Bar className="w-2/3" />
            </div>
          </div>
        </div>
        <div className={`${panel} absolute left-[74%] top-[70%] w-[22%] -translate-y-1/2 p-2.5`}>
          <div className="flex items-center gap-2">
            <Avatar kind="agent" id="scenario-receiver" name="Agent" size="sm" />
            <div className="hidden w-full space-y-1.5 sm:block">
              <Bar strong className="w-full" />
              <Bar className="w-2/3" />
            </div>
          </div>
        </div>

        <div className={`${panel} absolute left-[36%] top-1/2 w-[28%] -translate-y-1/2 p-3`}>
          <p className={accentCaption}>{copy.focus}</p>
          <div className="mt-2.5 space-y-1.5">
            <Bar className="w-full" />
            <Bar className="w-4/5" />
          </div>
          <div className="mt-2.5 hidden flex-wrap gap-1 sm:flex">
            {copy.chips.map((chip) => (
              <Badge tone="neutral" key={chip} >
                {chip}
              </Badge>
            ))}
          </div>
        </div>
        <p className="absolute bottom-3 left-4 text-xs text-[var(--bc-text-secondary)]">{copy.footer}</p>
      </VisualShell>
    );
  }

  return (
    <VisualShell flow>
      <div className="relative grid grid-cols-2 gap-2.5">
        {copy.chips.map((chip) => (
          <div key={chip} className={`${panel} p-3`}>
            <p className="text-xs font-medium text-[var(--bc-text)]">{chip}</p>
            <div className="mt-2.5 space-y-1.5">
              <Bar className="w-full" />
              <Bar className="w-2/3" />
            </div>
          </div>
        ))}
      </div>

      <div className={`${panel} relative mt-3 p-3.5`}>
        <div className="flex items-center justify-between gap-3">
          <p className={accentCaption}>{copy.focus}</p>
          <Badge tone="neutral" >
            sync
          </Badge>
        </div>
        <div aria-hidden="true" className="mt-3 h-2 overflow-hidden rounded-full bg-border">
          <div className="h-full w-[72%] rounded-full bg-accent" />
        </div>
        <p className="mt-2.5 text-xs text-[var(--bc-text-secondary)]">{copy.footer}</p>
      </div>
    </VisualShell>
  );
}

export default function AgentScenariosSection() {
  const locale = useLanguage();
  const t = agentScenarios[locale];

  return (
    <section className="relative px-6 pb-20 pt-0">
      <Card padding="md" className="relative mx-auto max-w-5xl overflow-hidden">
        <div className="relative px-6 py-10 sm:px-8 lg:px-12 lg:py-12">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-50px" }}
            transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
            className="max-w-4xl" >
            <span className="text-xs font-medium text-[var(--bc-accent-text)]">
              {t.label}
            </span>

            <h2 className="mt-3 text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-[var(--bc-text)] md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
              <span className="block">{t.titleStart}</span>
              <span className="mt-1 block">
                <span>{t.titleHighlight}</span>{" "}
                <span>{t.titleEnd}</span>
              </span>
            </h2>
          </motion.div>

          <div className="mt-10">
            {t.items.map((item, index) => {
              const number = String(index + 1).padStart(2, "0");
              const textOrderClass = index % 2 === 0 ? "lg:order-1" : "lg:order-2";
              const visualOrderClass =
                index % 2 === 0
                  ? "lg:order-2"
                  : "lg:order-1";

              return (
                <motion.article
                  key={item.title}
                  initial={{ opacity: 0, y: 16 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-50px" }}
                  transition={{ duration: 0.36, delay: index * 0.06, ease: [0, 0, 0, 1] }}
                  className="grid gap-4 border-t border-[var(--bc-border)] py-6 first:border-t-0 md:grid-cols-[96px_minmax(0,1fr)] md:gap-6 lg:grid-cols-[120px_minmax(0,1fr)] lg:py-7" >
                  <div className="flex items-start md:justify-start">
                    <span className="font-mono text-[40px] font-medium leading-none tracking-[-0.04em] text-[var(--bc-border-strong)] lg:text-[56px]">
                      {number}
                    </span>
                  </div>

                  <div className="mx-auto grid w-full max-w-[52rem] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-6">
                    <div className={`${textOrderClass} max-w-[28rem] lg:w-full`}>
                      <h3 className="text-[22px] font-semibold leading-[1.3] tracking-[-0.02em] text-[var(--bc-text)]">
                        {item.title}
                      </h3>

                      <p className="mt-3 max-w-[28rem] text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
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
      </Card>
    </section>
  );
}
