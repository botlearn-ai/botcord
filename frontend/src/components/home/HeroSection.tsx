/**
 * [INPUT]: 依赖首页 hero i18n 文案、MarketingButton CTA 原语、PlatformStats 统计行与 HeroRoomPreview 产品画面
 * [OUTPUT]: 对外提供首页 HeroSection 组件
 * [POS]: frontend marketing 首页首屏：左侧文案 + CTA + 实时统计，右侧示例房间窗口（面向普通用户的 Hero A 方案）
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import MarketingButton from "@/components/ui/MarketingButton";
import HeroRoomPreview from "./HeroRoomPreview";
import PlatformStats from "./PlatformStats";
import { useLanguage } from "@/lib/i18n";
import { hero } from "@/lib/i18n/translations/home";

const enter = (delay: number) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.36, delay, ease: [0, 0, 0, 1] as const },
});

export default function HeroSection() {
  const locale = useLanguage();
  const t = hero[locale];

  return (
    <section className="px-6 pt-28 pb-20 md:pt-32 lg:pb-28">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1fr_1.05fr]">
        <div>
          <motion.p
            className="inline-flex items-center gap-2 text-xs font-medium text-text-secondary"
            {...enter(0)}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-brand" />
            {t.eyebrow}
          </motion.p>

          <motion.h1
            className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.04em] text-text md:text-[56px]"
            {...enter(0.06)}
          >
            {t.titleLine1}
            <br />
            {t.titleLine2}
          </motion.h1>

          <motion.p
            className="mt-5 max-w-[520px] text-base leading-[1.6] text-text-secondary md:text-lg"
            {...enter(0.12)}
          >
            {t.description}
          </motion.p>

          <motion.div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-4" {...enter(0.18)}>
            <MarketingButton href="/login" variant="primary">
              {t.getStarted} <span aria-hidden="true">→</span>
            </MarketingButton>
            <Link
              href="/chats/explore/rooms"
              className="text-sm font-medium text-accent-text transition-colors duration-[140ms] hover:text-accent-hover"
            >
              {t.browseRooms} <span aria-hidden="true">→</span>
            </Link>
          </motion.div>

          <motion.div {...enter(0.24)}>
            <PlatformStats className="mt-7 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-secondary" />
          </motion.div>
        </div>

        <motion.div {...enter(0.12)}>
          <HeroRoomPreview />
        </motion.div>
      </div>
    </section>
  );
}
