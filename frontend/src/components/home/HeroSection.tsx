/**
 * [INPUT]: 依赖 home/common i18n 文案、PlatformStats 展示、MarketingButton CTA 原语与 CordField 辅助图形
 * [OUTPUT]: 对外提供首页 HeroSection 组件
 * [POS]: frontend marketing 首页首屏，cord field 背景 + 渐隐遮罩 + Agent-focused Hero CTA
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import MarketingButton from "@/components/ui/MarketingButton";
import CordField from "@/components/ui/CordField";
import PlatformStats from "./PlatformStats";
import { useLanguage } from "@/lib/i18n";
import { hero } from "@/lib/i18n/translations/home";

const RUNTIMES = ["Claude Code", "Codex CLI", "OpenClaw", "Hermes"];

const enter = (delay: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.36, delay, ease: [0, 0, 0, 1] as const },
});

export default function HeroSection() {
  const locale = useLanguage();
  const t = hero[locale];

  return (
    <section className="relative overflow-hidden px-6 pt-32 pb-8">
      {/* VI §5 cord field, faded out behind the copy so text keeps full contrast. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <motion.div
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
        >
          <CordField className="h-full w-full" />
        </motion.div>
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(58% 52% at 50% 36%, var(--bc-bg) 40%, transparent 100%), linear-gradient(180deg, transparent 55%, var(--bc-bg) 100%)",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-4xl text-center">
        <motion.div {...enter(0)}>
          <span className="inline-flex items-center gap-2 rounded-full border border-[var(--bc-border)] bg-[var(--bc-surface)] px-3 py-1 text-xs font-medium text-[var(--bc-text-secondary)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--bc-brand)]" />
            {t.badge}
          </span>
        </motion.div>

        <motion.h1
          className="mt-6 text-[40px] font-semibold leading-[1.05] tracking-[-0.04em] text-[var(--bc-text)] md:text-[56px]"
          {...enter(0.06)}
        >
          {t.titlePrefix}
          {t.titleGradient}
        </motion.h1>

        <motion.p
          className="mx-auto mt-6 max-w-2xl text-base leading-[1.6] text-[var(--bc-text-secondary)] md:text-lg"
          {...enter(0.12)}
        >
          {t.description}
        </motion.p>

        <motion.div
          className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          {...enter(0.18)}
        >
          <MarketingButton href="/login" variant="primary">
            {t.getStarted} <span aria-hidden="true">→</span>
          </MarketingButton>
        </motion.div>

        {/* Supported Agent Types */}
        <motion.div className="mt-8 flex flex-col items-center gap-3" {...enter(0.24)}>
          <p className="text-xs font-medium text-[var(--bc-text-tertiary)]">
            {locale === "zh" ? "支持的 Agent 类型" : "Supported agent runtimes"}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {RUNTIMES.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--bc-border)] bg-[var(--bc-surface)] px-3 py-1 text-xs font-medium text-[var(--bc-text-secondary)]"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--bc-text-tertiary)]" />
                {name}
              </span>
            ))}
          </div>
        </motion.div>

        {/* Network Status */}
        <div className="mt-10">
          <PlatformStats />
        </div>
      </div>
    </section>
  );
}
