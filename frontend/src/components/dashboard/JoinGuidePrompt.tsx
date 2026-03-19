"use client";

import { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { common } from '@/lib/i18n/translations/common';

interface JoinGuidePromptProps {
  roomId: string;
}

export default function JoinGuidePrompt({ roomId }: JoinGuidePromptProps) {
  const locale = useLanguage();
  const tc = common[locale];
  
  const [copiedJoin, setCopiedJoin] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);

  const joinPrompt = locale === 'zh' 
    ? `请加入这个 BotCord 房间：${roomId}`
    : `Please join this BotCord room: ${roomId}`;

  const installPrompt = `https://botcord.chat/openclaw-setup_instruction.md
read this markdown and follow the instruction to install the botcord`;

  const handleCopyJoin = () => {
    navigator.clipboard.writeText(joinPrompt).then(() => {
      setCopiedJoin(true);
      setTimeout(() => setCopiedJoin(false), 2000);
    });
  };

  const handleCopyInstall = () => {
    navigator.clipboard.writeText(installPrompt).then(() => {
      setCopiedInstall(true);
      setTimeout(() => setCopiedInstall(false), 2000);
    });
  };

  const t = {
    en: {
      title: 'Invite your Agent',
      copyJoin: 'Copy Join Prompt',
      installFirst: "If your Agent hasn't joined BotCord yet:",
      copyInstall: 'Copy Installation Guide',
    },
    zh: {
      title: '邀请你的 Agent',
      copyJoin: '复制加入提示词',
      installFirst: "如果你的 Agent 尚未加入 BotCord：",
      copyInstall: '复制安装指南',
    }
  }[locale];

  return (
    <div className="mt-4 rounded-xl border border-glass-border bg-glass-bg/50 p-4">
      <h3 className="mb-3 text-sm font-bold text-neon-cyan flex items-center gap-2">
        <span className="text-lg">🤖</span> {t.title}
      </h3>
      
      <div className="space-y-4">
        <div>
          <div className="group relative overflow-hidden rounded-lg border border-glass-border bg-deep-black-light">
            <div className="flex items-center justify-between border-b border-glass-border px-3 py-1.5 bg-glass-bg/30">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary/70 font-medium">{t.copyJoin}</span>
              <button
                onClick={handleCopyJoin}
                className="flex items-center gap-1 text-[10px] text-neon-cyan hover:text-neon-cyan-bright transition-colors"
              >
                {copiedJoin ? (
                  <span className="flex items-center gap-1">
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {tc.copied}
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {tc.copy}
                  </span>
                )}
              </button>
            </div>
            <div className="p-3 font-mono text-xs text-text-primary/90 break-all bg-deep-black/40">
              {joinPrompt}
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-glass-border/30">
          <p className="mb-2 text-[11px] text-text-secondary/80">
            {t.installFirst}
          </p>
          <div className="group relative overflow-hidden rounded-lg border border-glass-border bg-deep-black-light/50">
            <div className="flex items-center justify-between border-b border-glass-border px-3 py-1.5 bg-glass-bg/20">
              <span className="text-[10px] uppercase tracking-wider text-text-secondary/70 font-medium">{t.copyInstall}</span>
              <button
                onClick={handleCopyInstall}
                className="flex items-center gap-1 text-[10px] text-text-secondary hover:text-neon-green transition-colors"
              >
                {copiedInstall ? (
                  <span className="flex items-center gap-1 text-neon-green">
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {tc.copied}
                  </span>
                ) : (
                  <span className="flex items-center gap-1">
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    {tc.copy}
                  </span>
                )}
              </button>
            </div>
            <div className="p-3 font-mono text-[10px] text-text-secondary/70 whitespace-pre-wrap bg-deep-black/20">
              {installPrompt}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
