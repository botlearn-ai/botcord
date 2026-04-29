/**
 * [INPUT]: 首页 i18n 文案、SectionHeading 原语、可选 YouTube embed URL
 * [OUTPUT]: 对外提供首页视频介绍区组件
 * [POS]: marketing 首页 Hero 下方的视频说明模块
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import SectionHeading from "@/components/ui/SectionHeading";
import { useLanguage } from "@/lib/i18n";
import { introVideo } from "@/lib/i18n/translations/home";

const VIDEO_EMBED_URL = process.env.NEXT_PUBLIC_BOTCORD_YOUTUBE_EMBED_URL?.trim() ?? "";

export default function WhatIsBotCordSection() {
  const locale = useLanguage();
  const t = introVideo[locale];
  const hasVideo = VIDEO_EMBED_URL.length > 0;

  return (
    <section className="relative px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          title={t.title}
          subtitle={t.subtitle}
          accentColor="cyan"
        />

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.65, ease: "easeOut" }}
          className="relative overflow-hidden rounded-[34px] border border-white/10 bg-[radial-gradient(circle_at_top,rgba(0,240,255,0.12),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.02))] p-3 shadow-[0_30px_90px_rgba(0,0,0,0.35)]"
        >
          <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(255,255,255,0.025)_0,rgba(255,255,255,0)_12%,rgba(255,255,255,0)_88%,rgba(255,255,255,0.025)_100%)]" />

          <div className="relative overflow-hidden rounded-[28px] border border-white/8 bg-[#06080d]">
            <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-between px-5 py-4 text-[10px] font-medium uppercase tracking-[0.32em] text-white/40">
              <span>BotCord</span>
              <span>YouTube</span>
            </div>

            <div className="aspect-video">
              {hasVideo ? (
                <iframe
                  className="h-full w-full"
                  src={VIDEO_EMBED_URL}
                  title={t.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              ) : (
                <div className="flex h-full items-center justify-center px-8 py-16 text-center">
                  <div className="max-w-2xl">
                    <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full border border-neon-cyan/18 bg-neon-cyan/10 shadow-[0_0_30px_rgba(0,240,255,0.12)]">
                      <span className="ml-1 text-lg text-neon-cyan">▶</span>
                    </div>

                    <h3 className="mt-6 text-2xl font-semibold text-text-primary md:text-[2rem]">
                      {t.placeholderTitle}
                    </h3>

                    <p className="mx-auto mt-4 max-w-xl text-sm leading-7 text-text-secondary md:text-base">
                      {t.placeholderBody}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
