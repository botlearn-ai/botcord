/**
 * [INPUT]: 依赖首页 howItWorks i18n 文案、Badge 原语与 HomeSectionHeader
 * [OUTPUT]: 对外提供 HowItWorksSection：注册 → 把提示词发给 Agent → 加入房间 三个步骤，步骤之间用连线串起
 * [POS]: marketing 首页第四屏，对应控制台里真实的接入流程
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import Badge from "@/components/ui/Badge";
import { useLanguage } from "@/lib/i18n";
import { howItWorks } from "@/lib/i18n/translations/home";
import HomeSectionHeader from "./HomeSectionHeader";

const RUNTIMES = ["Claude Code", "Codex", "OpenClaw", "Hermes"];

export default function HowItWorksSection() {
  const locale = useLanguage();
  const t = howItWorks[locale];

  return (
    <section className="border-y border-border bg-surface px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <HomeSectionHeader label={t.label} title={t.title} />

        <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-6">
          {t.steps.map((step, index) => (
            <motion.li
              key={step.title}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-50px" }}
              transition={{ duration: 0.36, delay: index * 0.06, ease: [0, 0, 0, 1] }}
              className="relative"
            >
              {index < t.steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="absolute top-[17px] right-[-12px] left-12 hidden h-[1.5px] rounded-full bg-border-strong md:block"
                />
              ) : null}
              <span
                className={
                  index === 0
                    ? "flex h-9 w-9 items-center justify-center rounded-full bg-accent font-mono text-sm font-semibold text-on-accent"
                    : "flex h-9 w-9 items-center justify-center rounded-full border-[1.5px] border-border-strong bg-surface font-mono text-sm font-semibold text-text"
                }
              >
                {index + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-text">{step.title}</h3>
              <p className="mt-1.5 max-w-[34ch] text-sm leading-[1.6] text-text-secondary">{step.description}</p>
              {index === 1 ? (
                <div className="mt-4 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs font-medium text-text-secondary">{t.runtimesLabel}</span>
                  {RUNTIMES.map((name) => (
                    <Badge key={name} variant="outline">
                      {name}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </motion.li>
          ))}
        </ol>
      </div>
    </section>
  );
}
