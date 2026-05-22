"use client";

import { Apple, Shield, AlertTriangle } from "lucide-react";
import NeonButton from "@/components/ui/NeonButton";
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
        <span className="inline-block rounded-full border border-neon-cyan/30 bg-neon-cyan/5 px-4 py-1.5 text-xs font-medium tracking-wider text-neon-cyan">
          {t.badge}
        </span>
        <h1 className="mt-6 text-4xl font-bold leading-tight md:text-5xl">
          {t.title}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-text-secondary">
          {t.description}
        </p>

        <div className="mt-10 flex flex-col items-start gap-3">
          <NeonButton href={DMG_URL} variant="cyan-filled">
            <Apple className="h-5 w-5" />
            {t.downloadCta}
          </NeonButton>
          <div className="text-sm text-text-secondary">
            {t.arch} ·{" "}
            <a href={DMG_URL} className="text-neon-cyan hover:underline">
              {DMG_NAME}
            </a>
          </div>
          <div className="text-xs text-text-secondary">{t.version}</div>
        </div>

        <div className="mt-12 rounded-2xl border border-glass-border bg-glass-background p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Shield className="h-5 w-5 text-neon-cyan" />
            {t.securityHeading}
          </h2>
          <ol className="mt-4 space-y-3 text-sm text-text-secondary">
            {t.securitySteps.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neon-cyan/10 text-xs font-medium text-neon-cyan">
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-6 rounded-xl border border-neon-purple/20 bg-neon-purple/5 p-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-neon-purple" />
            <div className="flex-1">
              <div className="text-sm font-medium text-text-primary">
                {t.troubleHeading}
              </div>
              <div className="mt-1 text-sm text-text-secondary">
                {t.troubleBody}
              </div>
              <pre className="mt-3 overflow-x-auto rounded-lg border border-glass-border bg-deep-black/60 px-3 py-2 font-mono text-xs text-neon-cyan">
                sudo xattr -cr /Applications/BotCord.app
              </pre>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
