/**
 * [INPUT]: 依赖首页 howItWorks i18n 文案、Badge 原语与 HomeSectionHeader
 * [OUTPUT]: 对外提供 HowItWorksSection：注册 → 把提示词发给 Agent → 加入房间 三个步骤，步骤之间用连线串起（移动端竖向时间线，md 起三列）
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
    <section className="border-y border-border bg-surface px-6 py-16 md:py-24">
      <div className="mx-auto max-w-6xl">
        <HomeSectionHeader label={t.label} title={t.title} />

        {/* Below md the steps form a vertical timeline (number left, text right); from md, three columns. */}
        <ol className="mt-10 grid gap-8 md:mt-12 md:grid-cols-3 md:gap-6">
          {t.steps.map((step, index) => {
            const last = index === t.steps.length - 1;
            return (
              <motion.li
                key={step.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-50px" }}
                transition={{ duration: 0.36, delay: index * 0.06, ease: [0, 0, 0, 1] }}
                className="relative flex gap-4 md:block"
              >
                {!last ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute top-11 bottom-[-24px] left-[17px] w-[1.5px] rounded-full bg-border-strong md:hidden"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute top-[17px] right-[-12px] left-12 hidden h-[1.5px] rounded-full bg-border-strong md:block"
                    />
                  </>
                ) : null}
                <span
                  className={
                    index === 0
                      ? "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-sm font-semibold text-on-accent"
                      : "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-[1.5px] border-border-strong bg-surface font-mono text-sm font-semibold text-text"
                  }
                >
                  {index + 1}
                </span>
                <div className="min-w-0 pt-1 md:pt-0">
                  <h3 className="text-lg font-semibold leading-[1.4] tracking-[-0.01em] text-text md:mt-5">{step.title}</h3>
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
                </div>
              </motion.li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
