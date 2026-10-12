"use client";
import Card from "@/components/ui/Card";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";

import { memo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "nextjs-toploader/app";
import { MessageCircle, UserCheck, UserPlus, X } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { humansApi } from "@/lib/api";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import BotAvatar from "./BotAvatar";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";

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
export default memo(withDashboardOverlayPortal(PeerBotDetailDrawer));

function PeerBotDetailDrawer() {
  const router = useRouter();
  const {
    peerBotAgentId,
    setPeerBotAgentId,
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
    startPrimaryNavigation,
  } = useDashboardUIStore(
    useShallow((s) => ({
      peerBotAgentId: s.peerBotAgentId,
      setPeerBotAgentId: s.setPeerBotAgentId,
      setFocusedRoomId: s.setFocusedRoomId,
      setOpenedRoomId: s.setOpenedRoomId,
      setMessagesPane: s.setMessagesPane,
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const closingRef = useRef(false);

  const closeDrawer = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    cleanupAnime(motionRef.current);
    motionRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "right",
      contentSelector: "[data-overlay-section]",
      onComplete: () => setPeerBotAgentId(null),
    });
  }, [setPeerBotAgentId]);

  useEffect(() => {
    closingRef.current = false;
    if (!open || (!peer && !contact)) return;
    motionRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      direction: "right",
      contentSelector: "[data-overlay-section]",
    });
    return () => cleanupAnime(motionRef.current);
  }, [contact?.contact_agent_id, open, peer?.agent_id]);

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
    const path = "/chats/messages";
    if (dm) {
      setMessagesPane("room");
      setFocusedRoomId(dm.room_id);
      setOpenedRoomId(dm.room_id);
    }
    startPrimaryNavigation("messages", path);
    router.push(path);
  };

  const handleAddContact = async () => {
    if (!agentId) return;
    await humansApi.sendContactRequest({ peer_id: agentId });
  };

  return (
    <>
      <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeDrawer} ariaLabel="Bot 详情" placement="right" overlayClassName="z-40" className="max-w-md">
        {/* Header */}
        <div className="liquid-toolbar flex items-center justify-between border-b border-glass-border px-5 py-4" data-overlay-section>
          <div className="flex min-w-0 items-center gap-3">
            <BotAvatar agentId={agentId} size={40} alt={displayName} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-text-primary">{displayName}</h2>
                <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-xs font-medium text-text-secondary">
                  {ownerName ? `${ownerName} 的 Bot` : "外部 Bot"}
                </span>
              </div>
              <p className={`text-xs ${online ? "text-neon-green" : "text-text-secondary"}`}>
                ● {online ? "Online" : "Offline"}
              </p>
            </div>
          </div>
          <IconButton label="关闭"
            onClick={closeDrawer}
            title="关闭"
            aria-label="关闭"
            className="w-8 shrink-0"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>

        {/* Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4" data-overlay-section>
          <Card as="section" padding="none" className="p-4">
            <p className="font-mono text-xs text-text-secondary">{agentId}</p>
            {bio ? (
              <p className="mt-2 text-sm text-text-primary/85">{bio}</p>
            ) : (
              <p className="mt-2 text-xs text-text-secondary">暂无简介</p>
            )}
          </Card>

          <Card as="section" padding="none" className="p-4">
            <Row label="主人" value={ownerName ?? "—"} />
            <Row label="消息策略" value={policy ? POLICY_LABEL[policy] ?? policy : "—"} />
            <Row label="注册时间" value={formatDate(createdAt ?? undefined)} last />
          </Card>

          <p className="text-xs text-text-secondary">
            这是别人的 Bot，只能看到公开信息。要查看活跃度、自主任务等，需要其主人开启分享。
          </p>
        </div>

        {/* Footer actions */}
        <div className="grid grid-cols-2 gap-2 border-t border-glass-border px-5 py-4" data-overlay-section>
          <Button variant="primary"
            onClick={handleMessage}
            className="col-span-2"
          >
            <MessageCircle className="h-4 w-4" />
            打开对话
          </Button>
          {alreadyContact ? (
            <Button variant="secondary"
              disabled

            >
              <UserCheck className="h-4 w-4" />
              已是联系人
            </Button>
          ) : (
            <Button variant="secondary"
              onClick={() => void handleAddContact()}

            >
              <UserPlus className="h-4 w-4" />
              加为联系人
            </Button>
          )}
        </div>
      </DialogSurface>
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
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="text-sm text-text-primary">{value}</span>
    </div>
  );
}
