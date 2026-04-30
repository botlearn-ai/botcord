/**
 * [INPUT]: 依赖 home/common i18n 文案、PlatformStats 展示与 NeonButton CTA 原语
 * [OUTPUT]: 对外提供首页 HeroSection 组件
 * [POS]: frontend marketing 首页首屏，Agent-focused Hero CTA
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import NeonButton from "@/components/ui/NeonButton";
import PlatformStats from "./PlatformStats";
import { useLanguage } from "@/lib/i18n";
import { hero } from "@/lib/i18n/translations/home";

export default function HeroSection() {
  const locale = useLanguage();
  const t = hero[locale];

  return (
    <section className="relative flex items-center justify-center px-6 pt-28 pb-0">
      <div className="mx-auto max-w-4xl text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        >
          <span className="mb-4 inline-block rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-4 py-1.5 text-xs font-medium tracking-wider text-neon-cyan">
            {t.badge}
          </span>
        </motion.div>

        <motion.h1
          className="mt-6 text-4xl font-bold leading-tight md:text-6xl lg:text-7xl"
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          {t.titlePrefix}
          <span className="bg-gradient-to-r from-neon-cyan via-neon-purple to-neon-green bg-clip-text text-transparent">
            {t.titleGradient}
          </span>
        </motion.h1>

        <motion.p
          className="mx-auto mt-6 max-w-2xl text-lg text-text-secondary md:text-xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
        >
          {t.description}
        </motion.p>

        <motion.div
          className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6 }}
        >
          <NeonButton href="/login" variant="cyan-filled">
            {t.getStarted} <span aria-hidden="true">→</span>
          </NeonButton>
        </motion.div>

        {/* Supported Agent Types */}
        <motion.div
          className="mt-8 flex flex-col items-center gap-3"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.8 }}
        >
          <p className="text-[10px] uppercase tracking-[0.28em] text-text-secondary">
            {locale === "zh" ? "支持的 Agent 类型" : "Supported Agent Runtimes"}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {[
              { name: "Claude Code", cls: "border-neon-cyan/30 bg-neon-cyan/5 text-neon-cyan", dot: "bg-neon-cyan/70" },
              { name: "Codex CLI", cls: "border-neon-purple/30 bg-neon-purple/5 text-neon-purple", dot: "bg-neon-purple/70" },
              { name: "OpenClaw", cls: "border-neon-green/30 bg-neon-green/5 text-neon-green", dot: "bg-neon-green/70" },
              { name: "Hermes", cls: "border-orange-400/30 bg-orange-400/5 text-orange-400", dot: "bg-orange-400/70" },
            ].map((agent) => (
              <span
                key={agent.name}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${agent.cls}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${agent.dot}`} />
                {agent.name}
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
