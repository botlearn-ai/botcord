"use client";

import React, { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { common } from '@/lib/i18n/translations/common';
import { joinGuide } from '@/lib/i18n/translations/dashboard';

interface JoinGuidePromptProps {
  roomId: string;
}

export default function JoinGuidePrompt({ roomId }: JoinGuidePromptProps) {
  const locale = useLanguage();
  const tc = common[locale];
  const t = joinGuide[locale];
  
  const [copied, setCopied] = useState(false);

  // Combined prompt: "Please join this room: ID. If not installed, read xxx to install."
  const combinedPrompt = `${t.joinPrompt}${roomId}\n\n${t.installHint}${t.installPrompt}`;

  const handleCopy = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(combinedPrompt).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    }
  };

  return (
    <div className="rounded-lg border border-glass-border bg-glass-bg/30 p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm">🤖</span>
          <h3 className="text-[11px] font-bold text-neon-cyan uppercase tracking-wider">
            {t.title}
          </h3>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-md border border-neon-cyan/30 bg-neon-cyan/10 px-2 py-1 text-[10px] font-medium text-neon-cyan transition-all hover:bg-neon-cyan/20 hover:border-neon-cyan/50"
        >
          {copied ? (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              {tc.copied}
            </>
          ) : (
            <>
              <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              {t.copyPrompt}
            </>
          )}
        </button>
      </div>
      
      <div className="group relative overflow-hidden rounded border border-glass-border/50 bg-deep-black-light/50">
        <div className="p-2.5 font-mono text-[10px] leading-relaxed text-text-secondary/80 bg-deep-black/30 whitespace-pre-wrap break-all">
          <span className="text-text-primary/90">{t.joinPrompt}{roomId}</span>
          {"\n\n"}
          <span className="opacity-60">{t.installHint}</span>
          <span className="text-neon-cyan/70 underline underline-offset-2">{t.installPrompt}</span>
        </div>
      </div>
    </div>
  );
}
