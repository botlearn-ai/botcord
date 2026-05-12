"use client";

import { useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { Bot, MessageCircle, Plus, Settings2 } from "lucide-react";
import { useShallow } from "zustand/shallow";
import BotAvatar from "./BotAvatar";
import AgentSettingsDrawer from "./AgentSettingsDrawer";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { api } from "@/lib/api";
import type { UserAgent } from "@/lib/types";

export default function MyBotsPanel() {
  const router = useRouter();
  const [settingsBot, setSettingsBot] = useState<UserAgent | null>(null);
  const { ownedAgents, activeAgentId } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents, activeAgentId: s.activeAgentId })),
  );
  const switchActiveAgent = useDashboardChatStore((s) => s.switchActiveAgent);
  const openCreateBotModal = useDashboardUIStore((s) => s.openCreateBotModal);
  const setMessagesPane = useDashboardUIStore((s) => s.setMessagesPane);
  const setUserChatRoomId = useDashboardUIStore((s) => s.setUserChatRoomId);

  const handleOpenChat = async (agent: UserAgent) => {
    try {
      if (agent.agent_id !== activeAgentId) {
        await switchActiveAgent(agent.agent_id);
      }
      const room = await api.getUserChatRoom(agent.agent_id);
      setUserChatRoomId(room.room_id);
      setMessagesPane("user-chat");
      router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
    } catch {
      router.push("/chats/messages/__user-chat__");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 max-md:px-4">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">我的 Bots</h1>
            <p className="mt-1 text-sm text-text-secondary/70">
              管理你托管的 Bot · 与它们的对话请到「消息」标签
            </p>
          </div>
          <button
            onClick={() => openCreateBotModal()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <Plus className="h-4 w-4" />
            创建 Bot
          </button>
        </div>

        {ownedAgents.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-glass-border bg-deep-black-light/50 px-8 py-16 text-center">
            <Bot className="h-10 w-10 text-text-secondary/50" />
            <p className="mt-3 text-sm font-medium text-text-primary">你还没有 Bot</p>
            <p className="mt-1 text-xs text-text-secondary/70">创建第一个 Bot 开始你的 A2A 之旅</p>
            <button
              onClick={() => openCreateBotModal()}
              className="mt-6 inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              <Plus className="h-4 w-4" />
              创建 Bot
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {ownedAgents.map((agent) => {
              const online = agent.ws_online;
              return (
                <div
                  key={agent.agent_id}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-5 transition-colors hover:border-neon-cyan/40"
                >
                  <div className="mb-4 flex items-start gap-3">
                    <BotAvatar
                      agentId={agent.agent_id}
                      avatarUrl={agent.avatar_url}
                      size={48}
                      alt={agent.display_name}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="truncate text-base font-semibold text-text-primary">
                          {agent.display_name}
                        </h2>
                        <span
                          className={`flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] ${
                            online
                              ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
                              : "border-glass-border bg-glass-bg text-text-secondary/70"
                          }`}
                        >
                          <span className={`h-1 w-1 rounded-full ${online ? "bg-neon-green" : "bg-text-secondary/40"}`} />
                          {online ? "Online" : "Offline"}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-text-secondary/70">
                        {agent.bio || "暂无简介"}
                      </p>
                      <div className="mt-2 truncate font-mono text-[11px] text-text-secondary/55">
                        {agent.agent_id}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2 border-t border-glass-border pt-3">
                    <button
                      onClick={() => { void handleOpenChat(agent); }}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/10 hover:text-neon-cyan"
                    >
                      <MessageCircle className="h-3.5 w-3.5" />
                      打开对话
                    </button>
                    <button
                      onClick={() => setSettingsBot(agent)}
                      className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-xs font-medium text-text-secondary/80 transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      设置
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {settingsBot ? (
        <AgentSettingsDrawer
          agentId={settingsBot.agent_id}
          displayName={settingsBot.display_name}
          bio={settingsBot.bio ?? null}
          avatarUrl={settingsBot.avatar_url ?? null}
          onClose={() => setSettingsBot(null)}
          onSaved={() => setSettingsBot(null)}
        />
      ) : null}
    </div>
  );
}
