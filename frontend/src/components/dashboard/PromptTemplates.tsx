"use client";

/**
 * [INPUT]: 依赖 onboarding prompt builders 与 i18n/dashboard 翻译
 * [OUTPUT]: 对外提供 PromptTemplates 组件，展示建群场景卡片并支持一键复制 Prompt
 * [POS]: explore/templates 子页面，帮助用户快速选择场景并复制对应 Prompt 给 Bot
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { promptTemplatesUi } from "@/lib/i18n/translations/dashboard";
import {
  buildSkillShareRoomPrompt,
  buildKnowledgeSubRoomPrompt,
  buildCreateRoomPrompt,
} from "@/lib/onboarding";

type TemplateId = "skill-share" | "knowledge-sub" | "custom";

interface TemplateCard {
  id: TemplateId;
  titleKey: "skillShareTitle" | "knowledgeSubTitle" | "customCreateTitle";
  descKey: "skillShareDesc" | "knowledgeSubDesc" | "customCreateDesc";
  tags: Array<keyof typeof promptTemplatesUi.en>;
  buildPrompt: (locale: "en" | "zh") => string;
}

const templates: TemplateCard[] = [
  {
    id: "skill-share",
    titleKey: "skillShareTitle",
    descKey: "skillShareDesc",
    tags: ["tagSubscription", "tagPublic", "tagReadOnly", "tagFileSharing"],
    buildPrompt: (locale) => buildSkillShareRoomPrompt({ locale }),
  },
  {
    id: "knowledge-sub",
    titleKey: "knowledgeSubTitle",
    descKey: "knowledgeSubDesc",
    tags: ["tagSubscription", "tagPublic", "tagInteractive", "tagKnowledge"],
    buildPrompt: (locale) => buildKnowledgeSubRoomPrompt({ locale }),
  },
  {
    id: "custom",
    titleKey: "customCreateTitle",
    descKey: "customCreateDesc",
    tags: ["tagFlexible"],
    buildPrompt: (locale) => buildCreateRoomPrompt({ locale }),
  },
];

function TemplateCardView({
  card,
  locale,
  t,
}: {
  card: TemplateCard;
  locale: "en" | "zh";
  t: (typeof promptTemplatesUi)["en"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const prompt = useMemo(() => card.buildPrompt(locale), [card, locale]);

  const handleCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light transition-colors hover:border-neon-purple/40">
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-sm font-semibold text-text-primary">{t[card.titleKey]}</h3>
        <p className="mt-1.5 text-xs leading-5 text-text-secondary">{t[card.descKey]}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-glass-border bg-glass-bg px-2.5 py-0.5 text-[10px] text-text-secondary"
            >
              {t[tag]}
            </span>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-glass-border/60 px-5 py-3">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="rounded-lg border border-neon-cyan/35 bg-neon-cyan/10 px-3.5 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
        >
          {copied ? t.copied : t.copyPrompt}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded-lg border border-glass-border px-3.5 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:border-neon-purple/40 hover:text-text-primary"
        >
          {expanded ? (locale === "zh" ? "收起" : "Collapse") : (locale === "zh" ? "预览 Prompt" : "Preview")}
        </button>
      </div>

      {/* Expandable prompt preview */}
      {expanded && (
        <div className="border-t border-glass-border/50 bg-deep-black/40">
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-[11px] leading-5 text-text-secondary/85">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function PromptTemplates() {
  const locale = useLanguage();
  const t = promptTemplatesUi[locale];

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden bg-deep-black">
      <div className="border-b border-glass-border px-5 py-4">
        <h2 className="text-base font-semibold text-text-primary">{t.title}</h2>
        <p className="mt-1 text-xs text-text-secondary">{t.subtitle}</p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {templates.map((card) => (
            <TemplateCardView key={card.id} card={card} locale={locale} t={t} />
          ))}
        </div>
      </div>
    </div>
  );
}
