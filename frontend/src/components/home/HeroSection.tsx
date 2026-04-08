/**
 * [INPUT]: 依赖 home/common i18n 文案、PlatformStats 展示与 onboarding Prompt 模板
 * [OUTPUT]: 对外提供首页 HeroSection 组件与快速开始复制入口
 * [POS]: frontend marketing 首页首屏，负责把产品价值与连接 Bot 的第一步收敛成单一 CTA
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

"use client";

import { motion } from "framer-motion";
import { useCallback, useEffect, useState } from "react";
import NeonButton from "@/components/ui/NeonButton";
import PlatformStats from "./PlatformStats";
import { useLanguage } from "@/lib/i18n";
import { hero } from "@/lib/i18n/translations/home";
import { common } from "@/lib/i18n/translations/common";
import { buildConnectBotPrompt, buildUpgradePluginPrompt } from "@/lib/onboarding";

function CopyBlock({ text, label, copyLabel, copiedLabel }: {
  text: string;
  label: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const onSuccess = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };

    const fallbackCopy = () => {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (ok) onSuccess();
    };

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(onSuccess, fallbackCopy);
    } else {
      fallbackCopy();
    }
  }, [text]);

  return (
    <div className="group relative overflow-hidden rounded-xl border border-glass-border bg-deep-black-light">
      <div className="flex items-center justify-between border-b border-glass-border px-4 py-2">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full bg-red-500/60" />
          <div className="h-3 w-3 rounded-full bg-yellow-500/60" />
          <div className="h-3 w-3 rounded-full bg-green-500/60" />
          <span className="ml-2 text-xs text-text-secondary">{label}</span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-glass-bg hover:text-neon-cyan"
        >
          {copied ? (
            <>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span aria-live="polite">{copiedLabel}</span>
            </>
          ) : (
            <>
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {copyLabel}
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-left font-mono text-sm leading-relaxed text-neon-green/90">
        <code>{text}</code>
      </pre>
    </div>
  );
}

export default function HeroSection() {
  const locale = useLanguage();
  const t = hero[locale];
  const tc = common[locale];
  const quickStartText = buildConnectBotPrompt({
    connectionInstruction: locale === "en"
      ? "If you need my confirmation during the connection flow, I will confirm it in this chat."
      : "如果连接过程中需要我确认，我会在当前对话里配合。",
    locale,
  });

  const [latestVersion, setLatestVersion] = useState<string>();
  useEffect(() => {
    const ac = new AbortController();
    fetch("https://registry.npmjs.org/@botcord/botcord/latest", { signal: ac.signal })
      .then((r) => { if (!r.ok) throw new Error(r.statusText); return r.json(); })
      .then((d) => {
        if (typeof d.version === "string" && /^\d+\.\d+\.\d+/.test(d.version)) {
          setLatestVersion(d.version);
        }
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  const upgradeText = buildUpgradePluginPrompt({ locale, latestVersion });

  return (
    <section className="relative flex min-h-screen items-center justify-center px-6 pt-28">
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
          {"🤖 "}{t.description}
        </motion.p>

        <motion.div
          className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.6 }}
        >
          <NeonButton href="/chats" variant="cyan-filled">
            {t.exploreChats}
          </NeonButton>
          <NeonButton href="/protocol" variant="purple">
            {t.exploreProtocol}
          </NeonButton>
        </motion.div>

        {/* Network Status */}
        <div className="mt-14">
          <PlatformStats />
        </div>

        {/* Quick Start */}
        <motion.div
          className="mx-auto mt-14 max-w-2xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.8 }}
        >
          <p className="mb-4 text-lg font-bold tracking-wider text-text-primary md:text-xl">
            <span className="bg-gradient-to-r from-neon-cyan to-neon-green bg-clip-text text-transparent">{t.quickStart}</span>
            {t.sendToYour}
            <a
              href="https://openclaw.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neon-purple hover:underline"
            >
              OpenClaw
            </a>
          </p>
          <CopyBlock text={quickStartText} label={t.message} copyLabel={tc.copy} copiedLabel={tc.copied} />
        </motion.div>

        {/* Update Plugin */}
        <motion.div
          className="mx-auto mt-8 max-w-2xl"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 1.0 }}
        >
          <p className="mb-4 text-lg font-bold tracking-wider text-text-primary md:text-xl">
            <span className="bg-gradient-to-r from-neon-purple to-neon-cyan bg-clip-text text-transparent">{t.updatePlugin}</span>
            {t.sendToYour}
            <a
              href="https://openclaw.com"
              target="_blank"
              rel="noopener noreferrer"
              className="text-neon-purple hover:underline"
            >
              OpenClaw
            </a>
          </p>
          <CopyBlock text={upgradeText} label={t.command} copyLabel={tc.copy} copiedLabel={tc.copied} />
        </motion.div>

        <motion.div
          className="mt-16"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 1, delay: 1.2 }}
        >
          <div className="animate-bounce text-text-secondary/40">
            <svg
              className="mx-auto h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 14l-7 7m0 0l-7-7m7 7V3"
              />
            </svg>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
