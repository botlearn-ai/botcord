"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, FileArchive, Loader2, MessageSquare, Users, User, X } from "lucide-react";
import { api, apiFetch, getActiveIdentity } from "@/lib/api";
import { animatePop, cleanupAnime, createTimelineIfMotion } from "@/lib/anime";
import type { Attachment } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import DashboardMultiSelect from "./DashboardMultiSelect";
import { useShallow } from "zustand/react/shallow";

interface ForwardTarget {
  id: string;
  kind: "agent" | "room" | "contact";
  label: string;
  sublabel?: string;
}

interface ForwardModalProps {
  quoteText: string;
  sourceFile?: {
    url: string;
    filename: string;
    contentType?: string;
    sizeBytes?: number;
  };
  onClose: () => void;
}

export default withDashboardOverlayPortal(ForwardModal, "nested");

function ForwardModal({ quoteText, sourceFile, onClose }: ForwardModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const modalAnimationRef = useRef<ReturnType<typeof createTimelineIfMotion>>(null);
  const successAnimationRef = useRef<ReturnType<typeof animatePop>>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const router = useRouter();
  const {
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
  } = useDashboardUIStore(useShallow((s) => ({
    setFocusedRoomId: s.setFocusedRoomId,
    setOpenedRoomId: s.setOpenedRoomId,
    setMessagesPane: s.setMessagesPane,
  })));

  const { ownedAgents, viewMode } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents, viewMode: s.viewMode }))
  );
  const overview = useDashboardChatStore((s) => s.overview);

  const allTargets: ForwardTarget[] = [
    ...(viewMode !== "agent"
      ? ownedAgents.map((a) => ({
          id: `agent:${a.agent_id}`,
          kind: "agent" as const,
          label: a.display_name,
          sublabel: a.agent_id,
        }))
      : []),
    ...(overview?.contacts ?? []).map((c) => ({
      id: `contact:${c.contact_agent_id}`,
      kind: "contact" as const,
      label: c.alias || c.display_name,
      sublabel: c.contact_agent_id,
    })),
    ...(overview?.rooms ?? [])
      .filter((r) => !r.room_id.startsWith("rm_oc_"))
      .map((r) => ({
        id: `room:${r.room_id}`,
        kind: "room" as const,
        label: r.name,
        sublabel: r.room_id,
      })),
  ];

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      cleanupAnime(modalAnimationRef.current);
      cleanupAnime(successAnimationRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;

    overlay.style.opacity = "0";
    panel.style.opacity = "0";
    panel.style.transform = "translateY(10px) scale(0.985)";
    panel.style.transformOrigin = "center center";

    const timeline = createTimelineIfMotion({
      onComplete: () => {
        if (modalAnimationRef.current === timeline) modalAnimationRef.current = null;
      },
    });
    modalAnimationRef.current = timeline;

    if (!timeline) {
      overlay.style.opacity = "1";
      panel.style.opacity = "1";
      panel.style.transform = "translateY(0px) scale(1)";
      return;
    }

    timeline.add(overlay, {
      opacity: [0, 1],
      duration: 150,
      ease: "linear",
    }, 0);
    timeline.add(panel, {
      opacity: [0, 1],
      translateY: [10, 0],
      scale: [0.985, 1],
      duration: 220,
      ease: "out(3)",
    }, 20);

    return () => cleanupAnime(timeline);
  }, []);

  const closeModal = useCallback(() => {
    if (closingRef.current) return;

    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) {
      onClose();
      return;
    }

    closingRef.current = true;
    setClosing(true);
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    modalAnimationRef.current?.pause();

    const finishClose = () => {
      modalAnimationRef.current = null;
      onClose();
    };

    const timeline = createTimelineIfMotion({
      onComplete: finishClose,
    });
    modalAnimationRef.current = timeline;

    if (!timeline) {
      finishClose();
      return;
    }

    timeline.add(panel, {
      opacity: 0,
      translateY: 8,
      scale: 0.985,
      duration: 150,
      ease: "in(2)",
    }, 0);
    timeline.add(overlay, {
      opacity: 0,
      duration: 140,
      ease: "linear",
    }, 0);
  }, [onClose]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeModal]);

  useEffect(() => {
    if (!done) return;

    const frameId = window.requestAnimationFrame(() => {
      const status = statusRef.current;
      if (!status) return;

      cleanupAnime(successAnimationRef.current);
      successAnimationRef.current = animatePop(status);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [done]);

  const handleSend = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      let attachments: Attachment[] | undefined;
      if (sourceFile) {
        const activeIdentity = getActiveIdentity();
        const uploadAgentId =
          activeIdentity?.type === "agent"
            ? activeIdentity.id
            : ownedAgents[0]?.agent_id;
        const res = await apiFetch(sourceFile.url, { cache: "no-store" });
        if (!res.ok) throw new Error("Failed to prepare file for sending");
        const blob = await res.blob();
        const file = new File([blob], sourceFile.filename, {
          type: sourceFile.contentType || blob.type || "application/zip",
        });
        const uploaded = await api.uploadFile(file, uploadAgentId);
        attachments = [{
          filename: uploaded.original_filename,
          url: uploaded.url,
          content_type: uploaded.content_type,
          size_bytes: uploaded.size_bytes,
        }];
      }
      const openRoomIds: string[] = [];
      await Promise.all(
        [...selected].map(async (targetId) => {
          const [kind, id] = targetId.split(":") as ["agent" | "contact" | "room", string];
          if (kind === "agent") {
            await api.sendUserChatMessage(quoteText, attachments, id);
          } else if (kind === "contact") {
            const dmRoom = await api.openDmRoom(id);
            await api.sendRoomHumanMessage(dmRoom.room_id, quoteText, undefined, undefined, attachments);
            openRoomIds.push(dmRoom.room_id);
          } else {
            await api.sendRoomHumanMessage(id, quoteText, undefined, undefined, attachments);
            openRoomIds.push(id);
          }
        })
      );
      setDone(true);
      // Navigate to the forwarded conversation — if exactly one room target, open it directly
      if (openRoomIds.length === 1) {
        const roomId = openRoomIds[0];
        setMessagesPane("room");
        setFocusedRoomId(roomId);
        setOpenedRoomId(roomId);
        router.push("/chats/messages");
      }
      closeTimerRef.current = setTimeout(closeModal, 800);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "发送失败");
      setSending(false);
    }
  };

  return (
    <div
      ref={overlayRef}
      className={`liquid-scrim fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm ${closing ? "pointer-events-none" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) closeModal();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        className="liquid-dialog w-full max-w-sm rounded-xl border"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
          <span className="text-sm font-medium text-text-primary">转发消息</span>
          <button
            type="button"
            onClick={closeModal}
            className="liquid-action rounded-md p-1 text-text-secondary transition-colors hover:text-text-primary"
            aria-label="Close forward modal"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quote / file preview */}
        <div className="liquid-card mx-4 mt-3 rounded-lg border px-3 py-2">
          {sourceFile ? (
            <div className="flex items-center gap-2 text-text-primary">
              <FileArchive className="h-4 w-4 shrink-0 text-cyan-400" />
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">{sourceFile.filename}</p>
                {sourceFile.sizeBytes != null && (
                  <p className="text-[10px] text-text-secondary">{sourceFile.sizeBytes} bytes</p>
                )}
              </div>
            </div>
          ) : (
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-text-secondary">
              {quoteText}
            </pre>
          )}
        </div>

        {/* Target selector */}
        <div className="px-4 py-3">
          <DashboardMultiSelect
            value={Array.from(selected)}
            onChange={(next) => setSelected(new Set(next))}
            placeholder="选择发送目标"
            searchPlaceholder="搜索联系人或房间..."
            emptyLabel="暂无可用目标"
            selectedLabel={(count) => (count > 0 ? `已选 ${count} 个` : "未选择")}
            groups={[
              {
                options: allTargets.map((target) => ({
                  value: target.id,
                  label: target.label,
                  sublabel: target.sublabel,
                  badge: target.kind === "room" ? "Room" : target.kind === "agent" ? "Bot" : "Contact",
                  tone: target.kind === "room" ? "purple" : target.kind === "agent" ? "cyan" : "green",
                  icon:
                    target.kind === "room" ? (
                      <Users className="h-3.5 w-3.5 text-neon-purple/70" />
                    ) : target.kind === "agent" ? (
                      <MessageSquare className="h-3.5 w-3.5 text-neon-cyan/70" />
                    ) : (
                      <User className="h-3.5 w-3.5 text-neon-green/70" />
                    ),
                })),
              },
            ]}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-glass-border px-4 py-3">
          {error && <p className="text-[11px] text-red-400">{error}</p>}
          {done && (
            <p ref={statusRef} className="flex origin-center items-center gap-1.5 text-[11px] text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              已发送
            </p>
          )}
          {!error && !done && (
            <span className="text-[11px] text-text-secondary">
              {selected.size > 0 ? `已选 ${selected.size} 个` : "选择发送目标"}
            </span>
          )}
          <button
            type="button"
            disabled={selected.size === 0 || sending || done}
            onClick={handleSend}
            className="liquid-action ml-auto flex items-center gap-1.5 rounded-lg border border-neon-cyan/35 bg-neon-cyan/15 px-3 py-1.5 text-xs font-medium text-neon-cyan hover:bg-neon-cyan/25 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
          >
            {sending && <Loader2 className="h-3 w-3 animate-spin" />}
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
