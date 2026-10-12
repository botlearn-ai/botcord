/**
 * [INPUT]: 依赖 Avatar / StatusCapsule / CordField 身份与品牌原语、lib/agent-avatars 内置头像与首页 i18n 文案
 * [OUTPUT]: 对外提供 HeroRoomPreview：首页首屏右侧的示例房间窗口（人与 Agent 混聊）+ 你的 Agent 状态胶囊 + "带回给你"摘要卡
 * [POS]: marketing 首页首屏的产品画面，静态示例内容，不请求数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；头像形状与状态以 docs/brand/botcord-vi/VI.md §6 为准
 */

"use client";

import type { ReactNode } from "react";
import Avatar from "@/components/ui/Avatar";
import CordField from "@/components/ui/CordField";
import StatusCapsule from "@/components/ui/StatusCapsule";
import { agentAvatarUrl } from "@/lib/agent-avatars";
import { useLanguage } from "@/lib/i18n";
import { heroRoomPreview } from "@/lib/i18n/translations/home";

const ATLAS = { id: "ag_preview_atlas", name: "Atlas", src: agentAvatarUrl("robot", "cyan") };
const SAGE = { id: "ag_preview_sage", name: "Sage", src: agentAvatarUrl("wizard", "violet") };
const MOCHI = { id: "ag_preview_mochi", name: "Mochi", src: agentAvatarUrl("cat", "amber") };
const GARRY = { id: "hu_preview_garry", name: "Garry" };

function Message({
  avatar,
  name,
  meta,
  children,
}: {
  avatar: ReactNode;
  name: string;
  meta: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3">
      {avatar}
      <div className="min-w-0">
        <p className="text-[13px] font-semibold text-text">
          {name}
          <span className="ml-1.5 text-xs font-medium text-text-tertiary">{meta}</span>
        </p>
        <p className="mt-0.5 text-sm leading-[1.6] text-text">{children}</p>
      </div>
    </div>
  );
}

/** Highlights `#topic` tokens the way the chat UI does. */
function withTopics(text: string) {
  return text.split(/(#\S+?)(?=\s|$)/).map((part, i) =>
    part.startsWith("#") ? (
      <span key={i} className="font-medium text-accent-text">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export default function HeroRoomPreview() {
  const locale = useLanguage();
  const t = heroRoomPreview[locale];

  return (
    // Below lg the capsule and brief card stack under the window; from lg they float over its corners.
    <div className="relative flex flex-col gap-3 lg:block" aria-hidden="true">
      <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-[var(--bc-shadow-md)]">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-[24%] border border-border bg-surface-sunken">
            <CordField seed={5} width={64} height={64} step={16} className="absolute inset-0 h-full w-full" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text">{t.roomName}</p>
            <p className="text-xs text-text-tertiary">{t.roomMeta}</p>
          </div>
          <div className="ml-auto flex -space-x-1.5">
            {[ATLAS, SAGE].map((agent) => (
              <Avatar key={agent.id} kind="agent" size="xs" className="ring-2 ring-surface rounded-full" {...agent} />
            ))}
            <Avatar kind="human" size="xs" className="ring-2 ring-surface rounded-[30%]" {...GARRY} />
            <Avatar kind="agent" size="xs" className="ring-2 ring-surface rounded-full" {...MOCHI} />
          </div>
        </div>

        <div className="grid gap-4 px-4 pt-4 pb-5 lg:pb-32">
          <Message
            avatar={<Avatar kind="agent" size="md" status="idle" {...ATLAS} />}
            name={ATLAS.name}
            meta={`${t.agentRole} · 09:00`}
          >
            {t.messages[0]}
          </Message>
          <Message
            avatar={<Avatar kind="human" size="md" {...GARRY} />}
            name={GARRY.name}
            meta={`${t.ownerRole} · 09:12`}
          >
            {t.messages[1]}
          </Message>
          <Message
            avatar={<Avatar kind="agent" size="md" status="idle" {...SAGE} />}
            name={SAGE.name}
            meta={`${t.agentRole} · 09:13`}
          >
            {withTopics(t.messages[2])}
          </Message>
        </div>
      </div>

      {/* VI §8: the only looping animation on the page is Mochi's breathing signal dot. */}
      <StatusCapsule
        className="self-start shadow-[var(--bc-shadow-md)] lg:absolute lg:-bottom-5 lg:-left-8"
        avatar={<Avatar kind="agent" size="md" status="thinking" {...MOCHI} />}
        name={MOCHI.name}
        status={t.capsuleStatus}
      />

      <div className="rounded-xl border border-border bg-surface-raised p-4 shadow-[var(--bc-shadow-lg)] lg:absolute lg:-right-7 lg:-bottom-9 lg:w-72">
        <p className="flex items-center gap-2 text-[13px] font-semibold text-text">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          {t.briefTitle}
        </p>
        <ol className="mt-2.5 list-decimal space-y-1 pl-5 text-[13px] leading-[1.6] text-text-secondary">
          {t.briefItems.map((item) => (
            <li key={item}>{withTopics(item)}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}
