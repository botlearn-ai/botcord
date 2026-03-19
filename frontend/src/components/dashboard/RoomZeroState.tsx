"use client";

/**
 * [INPUT]: 依赖 useDashboard 获取登录态与当前 agent，依赖 next/navigation 跳转 Explore，依赖 i18n/common 输出空态与复制反馈
 * [OUTPUT]: 对外提供 RoomZeroState 组件，输出“复制建房 Prompt / 去 Explore 选房间 / 登录”动作
 * [POS]: messages 空态的统一引导层，被 Sidebar 与 ChatPane 复用，避免无房间时出现死胡同
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { roomZeroState } from "@/lib/i18n/translations/dashboard";

interface RoomZeroStateProps {
  compact?: boolean;
}

export default function RoomZeroState({ compact = false }: RoomZeroStateProps) {
  const router = useRouter();
  const { state, isGuest, isAuthedReady, showLoginModal } = useDashboard();
  const locale = useLanguage();
  const tc = common[locale];
  const t = roomZeroState[locale];
  const [copied, setCopied] = useState(false);

  const createRoomPrompt = useMemo(() => {
    const identityLine = state.activeAgentId
      ? `Use my active BotCord agent \`${state.activeAgentId}\` to create the room.`
      : "Use my current BotCord agent to create the room.";

    return [
      "Create a new BotCord room for me and configure permissions.",
      identityLine,
      "First ask me only the missing details: room name, purpose, whether it should be public or private, and who should be invited.",
      "Default to the safest sensible setup if I do not specify: private visibility, invite_only join policy, default_send=true, default_invite=false.",
      "After creation, tell me the room_id, the final visibility, the join policy, and the permission choices you made.",
      "If my request implies a broader audience, explain the tradeoff before switching to a public/open room.",
    ].join("\n");
  }, [state.activeAgentId]);

  const handleCopyPrompt = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    await navigator.clipboard.writeText(createRoomPrompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const containerClassName = compact
    ? "m-3 rounded-2xl border border-dashed border-glass-border bg-glass-bg/30 p-4"
    : "mx-auto flex w-full max-w-xl flex-col items-center rounded-3xl border border-dashed border-glass-border bg-glass-bg/30 p-6 text-center";

  return (
    <div className={containerClassName}>
      <div className={compact ? "" : "max-w-md"}>
        <p className="text-sm font-semibold text-text-primary">{t.title}</p>
        <p className="mt-2 text-xs leading-6 text-text-secondary">{t.description}</p>
      </div>

      <div className={`mt-4 flex ${compact ? "flex-col" : "flex-wrap justify-center"} gap-3`}>
        {isAuthedReady && (
          <button
            type="button"
            onClick={() => void handleCopyPrompt()}
            className="rounded-xl border border-neon-cyan/35 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            {copied ? tc.copied : t.copyPrompt}
          </button>
        )}
        <button
          type="button"
          onClick={() => router.push("/chats/explore/rooms")}
          className="rounded-xl border border-glass-border bg-deep-black-light px-4 py-2 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
        >
          {t.openExplore}
        </button>
        {isGuest && (
          <button
            type="button"
            onClick={showLoginModal}
            className="rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            {t.loginToCreate}
          </button>
        )}
      </div>

      {isAuthedReady && (
        <div className="mt-4 w-full overflow-hidden rounded-2xl border border-glass-border/70 bg-deep-black/40 text-left">
          <div className="border-b border-glass-border/60 px-4 py-2 text-[10px] uppercase tracking-[0.18em] text-text-secondary/70">
            {t.promptLabel}
          </div>
          <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-[11px] leading-5 text-text-secondary/85">
            {createRoomPrompt}
          </pre>
        </div>
      )}
    </div>
  );
}
