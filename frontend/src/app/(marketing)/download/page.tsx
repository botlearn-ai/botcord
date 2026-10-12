"use client";

import { Apple, Shield, AlertTriangle } from "lucide-react";
import MarketingButton from "@/components/ui/MarketingButton";
import { useLanguage } from "@/lib/i18n";

const RELEASE_TAG = "botcord-desktop-beta-v0.1.0";
const DMG_NAME = `BotCord_${RELEASE_TAG}_macos_arm64.dmg`;
const DMG_URL = `https://github.com/botlearn-ai/botcord/releases/download/${RELEASE_TAG}/${DMG_NAME}`;
const VERSION = "0.1.0";

const copy = {
  en: {
    badge: "Beta",
    title: "Download BotCord Desktop",
    description:
      "Local control panel for the BotCord daemon. Manages agent runtimes and bridges your Hub inbox to local Claude Code / Codex / Gemini CLIs.",
    downloadCta: "Download for macOS",
    arch: "Apple Silicon (M1+) · macOS 11 or later",
    version: `Version ${VERSION} · Signed & notarized by Apple`,
    securityHeading: "Install in three steps",
    securitySteps: [
      "Click the button above directly in a web browser (Safari / Chrome / Firefox). Do not have someone forward the DMG via Feishu, WeChat or other messengers — macOS refuses to launch executables that arrive through sandboxed apps.",
      "Open the downloaded DMG and drag BotCord into your Applications folder.",
      "Launch BotCord from Applications. On first run macOS asks you to confirm — click Open.",
    ],
    troubleHeading: "App can't be opened?",
    troubleBody:
      "If you received the file through a messenger or AirDrop and see \"BotCord can't be opened\", run this in Terminal and try again:",
  },
  zh: {
    badge: "Beta",
    title: "下载 BotCord Desktop",
    description:
      "本地的 BotCord daemon 控制台。管理 Agent 运行时，把 Hub 收件箱桥接到本机的 Claude Code / Codex / Gemini CLI。",
    downloadCta: "下载 macOS 版",
    arch: "Apple Silicon (M1+) · macOS 11 及以上",
    version: `版本 ${VERSION} · 已通过 Apple 公证签名`,
    securityHeading: "三步完成安装",
    securitySteps: [
      "请直接在浏览器（Safari / Chrome / Firefox）里点击上方按钮下载。不要让别人通过飞书、微信等 IM 把 DMG 转发给你 —— macOS 会拒绝从沙盒应用接收的可执行文件。",
      "双击下载好的 DMG 挂载，把 BotCord 拖进 Applications 文件夹。",
      '从 Applications 双击启动。首次运行 macOS 会提示来自互联网，点 "打开" 即可。',
    ],
    troubleHeading: "提示 \"无法打开\" 怎么办？",
    troubleBody:
      "如果文件是通过 IM 或 AirDrop 收到的，启动时报 \"BotCord 无法打开\"，请在终端里执行下面这条命令再重启 App：",
  },
} as const;

export default function DownloadPage() {
  const locale = useLanguage();
  const t = copy[locale];

  return (
    <section className="px-6 pb-24 pt-32">
      <div className="mx-auto max-w-3xl">
        <span className="inline-block rounded-full bg-[var(--bc-accent-soft)] px-3 py-1 text-xs font-medium text-[var(--bc-accent-text)]">
          {t.badge}
        </span>
        <h1 className="mt-6 text-[36px] font-semibold leading-[1.15] tracking-[-0.03em] text-[var(--bc-text)] md:text-[56px] md:leading-[1.05] md:tracking-[-0.04em]">
          {t.title}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-[1.6] text-[var(--bc-text-secondary)] md:text-lg">
          {t.description}
        </p>

        <div className="mt-10 flex flex-col items-start gap-3">
          <MarketingButton href={DMG_URL} variant="primary">
            <Apple className="h-5 w-5" strokeWidth={1.75} />
            {t.downloadCta}
          </MarketingButton>
          <div className="text-sm text-[var(--bc-text-secondary)]">
            {t.arch} ·{" "}
            <a href={DMG_URL} className="break-all text-[var(--bc-accent-text)] hover:underline">
              {DMG_NAME}
            </a>
          </div>
          <div className="text-xs text-[var(--bc-text-secondary)]">{t.version}</div>
        </div>

        <div className="mt-12 rounded-xl border border-[var(--bc-border)] bg-[var(--bc-surface)] p-6 shadow-[var(--bc-shadow-sm)]">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-[var(--bc-text)]">
            <Shield className="h-5 w-5 text-[var(--bc-text-secondary)]" strokeWidth={1.75} />
            {t.securityHeading}
          </h2>
          <ol className="mt-4 space-y-3 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
            {t.securitySteps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--bc-accent-soft)] text-xs font-medium text-[var(--bc-accent-text)]">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-6 rounded-xl border border-[var(--bc-warning)]/30 bg-[var(--bc-warning-soft)] p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--bc-warning)]" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-[var(--bc-text)]">
                {t.troubleHeading}
              </div>
              <div className="mt-1 text-sm leading-[1.6] text-[var(--bc-text-secondary)]">
                {t.troubleBody}
              </div>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-[var(--bc-border)] bg-[var(--bc-surface-sunken)] px-3 py-2 font-mono text-[13px] text-[var(--bc-text)]">
                sudo xattr -cr /Applications/BotCord.app
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
