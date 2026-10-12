"use client";

/**
 * [INPUT]: 依赖 onboarding prompt builders 与 i18n/dashboard 翻译
 * [OUTPUT]: 对外提供 PromptTemplates 组件，展示建房间场景卡片并支持一键复制 Prompt
 * [POS]: explore/templates 子页面，帮助用户快速选择场景并复制对应 Prompt 给 Bot
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { useMemo, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { promptTemplatesUi } from "@/lib/i18n/translations/dashboard";
import {
  buildSkillShareRoomPrompt,
  buildKnowledgeSubRoomPrompt,
  buildAgentServiceRoomPrompt,
  buildTeamAsyncRoomPrompt,
  buildOpcManagerRoomPrompt,
  buildOpcSwarmRoomPrompt,
  buildCreateRoomPrompt,
} from "@/lib/onboarding";

interface TemplateCard {
  id: string;
  titleKey: keyof typeof promptTemplatesUi.en;
  descKey: keyof typeof promptTemplatesUi.en;
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
    id: "agent-service",
    titleKey: "agentServiceTitle",
    descKey: "agentServiceDesc",
    tags: ["tagPublic", "tagService", "tagPayment", "tagInteractive"],
    buildPrompt: (locale) => buildAgentServiceRoomPrompt({ locale }),
  },
  {
    id: "team-async",
    titleKey: "teamAsyncTitle",
    descKey: "teamAsyncDesc",
    tags: ["tagPrivate", "tagTeam", "tagSmartNotify", "tagInteractive"],
    buildPrompt: (locale) => buildTeamAsyncRoomPrompt({ locale }),
  },
  {
    id: "opc-manager",
    titleKey: "opcManagerTitle",
    descKey: "opcManagerDesc",
    tags: ["tagOpc", "tagMultiAgent", "tagManager", "tagPrivate", "tagSmartNotify"],
    buildPrompt: (locale) => buildOpcManagerRoomPrompt({ locale }),
  },
  {
    id: "opc-swarm",
    titleKey: "opcSwarmTitle",
    descKey: "opcSwarmDesc",
    tags: ["tagOpc", "tagMultiAgent", "tagSwarm", "tagPrivate", "tagInteractive"],
    buildPrompt: (locale) => buildOpcSwarmRoomPrompt({ locale }),
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
    <Card padding="none" className="overflow-hidden">
      {/* Header */}
      <div className="px-5 pt-5 pb-3">
        <h3 className="text-sm font-semibold text-text-primary">{t[card.titleKey]}</h3>
        <p className="mt-1.5 text-xs leading-5 text-text-secondary">{t[card.descKey]}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {card.tags.map((tag) => (
            <Badge tone="neutral"
              key={tag}

            >
              {t[tag]}
            </Badge>
          ))}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 border-t border-glass-border/60 px-5 py-3">
        <Button variant="secondary" size="sm"
          type="button"
          onClick={() => void handleCopy()}

        >
          {copied ? t.copied : t.copyPrompt}
        </Button>
        <Button variant="secondary" size="sm"
          type="button"
          onClick={() => setExpanded((v) => !v)}

        >
          {expanded ? (locale === "zh" ? "收起" : "Collapse") : (locale === "zh" ? "预览 Prompt" : "Preview")}
        </Button>
      </div>

      {/* Expandable prompt preview */}
      {expanded && (
        <div className="liquid-tool-surface border-t border-glass-border/50">
          <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words px-5 py-4 font-mono text-xs leading-5 text-text-secondary">
            {prompt}
          </pre>
        </div>
      )}
    </Card>
  );
}

export default function PromptTemplates() {
  const locale = useLanguage();
  const t = promptTemplatesUi[locale];

  return (
    <div className="dashboard-main relative flex flex-1 flex-col overflow-hidden">
      <div className="liquid-toolbar border-b border-glass-border px-5 py-4">
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
