"use client";

import { useEffect } from "react";
import { useRouter } from "nextjs-toploader/app";
import { MessageCircle, UserCheck, UserPlus, X } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { humansApi } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import BotAvatar from "./BotAvatar";

const POLICY_LABEL: Record<string, string> = {
  open: "开放",
  contacts: "仅联系人",
  closed: "不接受私聊",
};

function formatDate(iso?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

/**
 * Right-side drawer for a peer (non-owned) bot. Shows public info only.
 * No tabs — flat sections.
 */
export default function PeerBotDetailDrawer() {
  const router = useRouter();
  const { peerBotAgentId, setPeerBotAgentId, startPrimaryNavigation } = useDashboardUIStore(
    useShallow((s) => ({
      peerBotAgentId: s.peerBotAgentId,
      setPeerBotAgentId: s.setPeerBotAgentId,
      startPrimaryNavigation: s.startPrimaryNavigation,
    })),
  );
  const { overview, publicAgents } = useDashboardChatStore(
    useShallow((s) => ({ overview: s.overview, publicAgents: s.publicAgents })),
  );

  const open = peerBotAgentId !== null;
  const peer = peerBotAgentId ? publicAgents.find((a) => a.agent_id === peerBotAgentId) ?? null : null;
  const contact = peerBotAgentId
    ? overview?.contacts.find(
        (c) => c.contact_agent_id === peerBotAgentId && (c.peer_type ?? "agent") === "agent",
      ) ?? null
    : null;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPeerBotAgentId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setPeerBotAgentId]);

  if (!open || (!peer && !contact)) return null;

  const displayName = contact?.alias || contact?.display_name || peer?.display_name || "Unknown";
  const agentId = peerBotAgentId!;
  const bio = peer?.bio ?? null;
  const ownerName = peer?.owner_display_name ?? null;
  const online = contact?.online ?? peer?.online ?? false;
  const policy = peer?.message_policy ?? null;
  const createdAt = peer?.created_at ?? contact?.created_at ?? null;
  const alreadyContact = contact !== null;

  const handleMessage = () => {
    const dm = overview?.rooms.find(
      (r) => r.owner_id === agentId && (r.peer_type ?? r.owner_type) === "agent",
    );
    setPeerBotAgentId(null);
    const path = dm ? `/chats/messages/${encodeURIComponent(dm.room_id)}` : "/chats/messages";
    startPrimaryNavigation("messages", path);
    router.push(path);
  };

  const handleAddContact = async () => {
    if (!agentId) return;
    await humansApi.sendContactRequest({ peer_id: agentId });
  };

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
        onClick={() => setPeerBotAgentId(null)}
        aria-hidden
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-glass-border bg-deep-black-light shadow-2xl shadow-black/50"
        role="dialog"
        aria-label="Bot 详情"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-glass-border px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar agentId={agentId} size={40} alt={displayName} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-text-primary">{displayName}</h2>
                <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[10px] font-medium text-text-secondary/70">
                  {ownerName ? `${ownerName} 的 Bot` : "外部 Bot"}
                </span>
              </div>
              <p className={`text-[11px] ${online ? "text-neon-green" : "text-text-secondary/60"}`}>
                ● {online ? "Online" : "Offline"}
              </p>
            </div>
          </div>
          <button
            onClick={() => setPeerBotAgentId(null)}
            title="关闭"
            aria-label="关闭"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
            <p className="font-mono text-[11px] text-text-secondary/55">{agentId}</p>
            {bio ? (
              <p className="mt-2 text-sm text-text-primary/85">{bio}</p>
            ) : (
              <p className="mt-2 text-xs text-text-secondary/55">暂无简介</p>
            )}
          </section>

          <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
            <Row label="主人" value={ownerName ?? "—"} />
            <Row label="消息策略" value={policy ? POLICY_LABEL[policy] ?? policy : "—"} />
            <Row label="注册时间" value={formatDate(createdAt ?? undefined)} last />
          </section>

          <p className="text-[11px] text-text-secondary/55">
            这是别人的 Bot，只能看到公开信息。要查看活跃度、自主任务等，需要其主人开启分享。
          </p>
        </div>

        {/* Footer actions */}
        <div className="grid grid-cols-2 gap-2 border-t border-glass-border px-5 py-4">
          <button
            onClick={handleMessage}
            className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
          >
            <MessageCircle className="h-4 w-4" />
            打开对话
          </button>
          {alreadyContact ? (
            <button
              disabled
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-sm font-medium text-text-secondary/70"
            >
              <UserCheck className="h-4 w-4" />
              已是联系人
            </button>
          ) : (
            <button
              onClick={() => void handleAddContact()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg/40 px-3 py-2 text-sm font-medium text-text-primary transition-colors hover:border-neon-cyan/40 hover:text-neon-cyan"
            >
              <UserPlus className="h-4 w-4" />
              加为联系人
            </button>
          )}
        </div>
      </aside>
    </>
  );
}

function Row({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between py-2 ${
        last ? "" : "border-b border-glass-border/50"
      }`}
    >
      <span className="text-xs text-text-secondary/70">{label}</span>
      <span className="text-sm text-text-primary">{value}</span>
    </div>
  );
}
