"use client";

/**
 * [INPUT]: 依赖 agent 资料与联系人关系状态，依赖 i18n 提供文案
 * [OUTPUT]: 对外提供 AgentCardModal 统一 agent 详情模态框
 * [POS]: dashboard 通用弹层组件，被 Explore 与成员列表等入口复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import CopyableId from "@/components/ui/CopyableId";
import { useLanguage } from "@/lib/i18n";
import { exploreUi } from "@/lib/i18n/translations/dashboard";
import type { AgentProfile } from "@/lib/types";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { usePresenceStore } from "@/store/usePresenceStore";
import { PresenceDot } from "./PresenceDot";
import BotAvatar from "./BotAvatar";

interface AgentCardModalProps {
  isOpen: boolean;
  agent: AgentProfile | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onOwnerOpen?: (owner: { humanId: string; displayName: string }) => void;
  alreadyInContacts: boolean;
  requestAlreadyPending: boolean;
  sendingFriendRequest?: boolean;
  onSendFriendRequest: () => void;
  onSendMessage?: () => void;
  onRetry?: () => void;
  isOwnAgent?: boolean;
}

export default function AgentCardModal({
  isOpen,
  agent,
  loading = false,
  error = null,
  onClose,
  onOwnerOpen,
  alreadyInContacts,
  requestAlreadyPending,
  sendingFriendRequest = false,
  onSendFriendRequest,
  onSendMessage,
  onRetry,
  isOwnAgent = false,
}: AgentCardModalProps) {
  const locale = useLanguage();
  const t = exploreUi[locale];
  const messagePolicyLabel = getMessagePolicyLabel(agent?.message_policy, t.messagePolicyLabels);

  useEffect(() => {
    if (!agent) return;
    usePresenceStore.getState().seed([{ agentId: agent.agent_id, online: Boolean(agent.online) }]);
  }, [agent]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {agent ? (
              <BotAvatar agentId={agent.agent_id} size={44} alt={agent.display_name} />
            ) : null}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <PresenceDot agentId={agent?.agent_id} fallback={agent?.online} size="md" />
                <h3 className="truncate text-base font-semibold text-text-primary">{agent?.display_name || "Agent"}</h3>
              </div>
              <p className="mt-1 text-xs text-text-secondary">{t.agentDetails}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded border border-glass-border px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>
        {loading ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-text-secondary">{agent?.bio || t.noBio}</p>
            <div className="flex items-center gap-2">
              {agent && <CopyableId value={agent.agent_id} />}
              <span className="rounded border border-glass-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                {messagePolicyLabel}
              </span>
            </div>
            <p className="text-xs text-text-secondary animate-pulse">Loading profile...</p>
          </div>
        ) : error ? (
          <div className="space-y-3 py-2">
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={onRetry}
              className="w-full rounded-lg border border-glass-border py-2 text-xs text-text-primary transition-colors hover:bg-glass-bg"
            >
              Retry
            </button>
          </div>
        ) : (
          <>
            <p className="mb-3 text-sm text-text-secondary">{agent?.bio || t.noBio}</p>
            {agent?.owner_human_id && agent.owner_display_name ? (
              <div className="mb-3 text-xs text-text-secondary">
                <span className="text-text-secondary/70">Human owner: </span>
                <button
                  type="button"
                  onClick={() => onOwnerOpen?.({
                    humanId: agent.owner_human_id!,
                    displayName: agent.owner_display_name!,
                  })}
                  className="rounded text-neon-green transition-colors hover:text-neon-green/80"
                >
                  {agent.owner_display_name}
                </button>
              </div>
            ) : null}
            <div className="mb-4 flex items-center gap-2">
              {agent && <CopyableId value={agent.agent_id} />}
              <span className="rounded border border-glass-border px-1.5 py-0.5 text-[10px] text-text-secondary">
                {messagePolicyLabel}
              </span>
            </div>
            {isOwnAgent ? (
              <button
                onClick={onSendMessage}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-green/40 bg-neon-green/10 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/20"
              >
                {t.sendMessage}
              </button>
            ) : alreadyInContacts ? (
              <button
                onClick={onSendMessage}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-green/40 bg-neon-green/10 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/20"
              >
                {t.sendMessage}
              </button>
            ) : requestAlreadyPending ? (
              <p className="text-xs text-neon-cyan">{t.friendRequestAlreadyPending}</p>
            ) : (
              <button
                onClick={onSendFriendRequest}
                disabled={sendingFriendRequest}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingFriendRequest ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {sendingFriendRequest ? t.sendingFriendRequest : t.sendFriendRequest}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function getMessagePolicyLabel(
  policy: string | null | undefined,
  labels: Record<"open" | "contacts_only" | "whitelist" | "closed", string>,
): string {
  if (!policy) return "-";
  return labels[policy as keyof typeof labels] || policy;
}
