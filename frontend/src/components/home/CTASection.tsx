/**
 * [INPUT]: 依赖首页 cta i18n 文案、MarketingButton CTA 原语与 CordField 辅助图形
 * [OUTPUT]: 对外提供 CTASection：cord field 背景上的结尾标题 + 单一主按钮 + 浏览房间文字链接
 * [POS]: marketing 首页最后一屏
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import MarketingButton from "@/components/ui/MarketingButton";
import CordField from "@/components/ui/CordField";
import { useLanguage } from "@/lib/i18n";
import { cta } from "@/lib/i18n/translations/home";

export default function CTASection() {
  const locale = useLanguage();
  const t = cta[locale];

  return (
    <section className="px-4 pb-16 md:px-6 md:pb-24">
      <motion.div
        className="relative mx-auto max-w-6xl overflow-hidden rounded-3xl border border-border bg-surface px-6 py-12 text-center md:py-20"
        initial={{ opacity: 0, y: 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-50px" }}
        transition={{ duration: 0.36, ease: [0, 0, 0, 1] }}
      >
        {/* VI §5: cord field behind the copy, faded out so the text keeps full contrast. */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <CordField width={1200} height={400} step={80} className="absolute inset-0 h-full w-full" />
          <div className="absolute inset-0 bg-[radial-gradient(50%_60%_at_50%_50%,var(--bc-surface)_35%,transparent_100%)]" />
        </div>

        <div className="relative">
          <h2 className="text-balance break-keep [overflow-wrap:anywhere] text-[28px] font-semibold leading-[1.2] tracking-[-0.025em] text-text md:text-[36px] md:leading-[1.15] md:tracking-[-0.03em]">
            {t.heading}
          </h2>
          <p className="mx-auto mt-3 max-w-lg text-pretty break-keep [overflow-wrap:anywhere] text-base leading-[1.6] text-text-secondary">{t.description}</p>
          <div className="mt-8 flex flex-col items-center justify-center gap-x-6 gap-y-4 sm:flex-row">
            <MarketingButton href="/login" variant="primary">
              {t.getStarted} <span aria-hidden="true">→</span>
            </MarketingButton>
            <Link
              href="/chats/explore/rooms"
              className="text-sm font-medium text-accent-text transition-colors duration-[140ms] hover:text-accent-hover"
            >
              {t.browseRooms} <span aria-hidden="true">→</span>
            </Link>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
