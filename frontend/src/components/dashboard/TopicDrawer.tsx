"use client";

/**
 * [INPUT]: 依赖 chat/ui/session store 的消息和焦点状态，复用 MessageBubble 和 RoomHumanComposer 渲染话题线程
 * [OUTPUT]: 对外提供带 animejs 进出场动效的 TopicDrawer 组件，作为从右侧滑出的话题详情面板
 * [POS]: dashboard 聊天正文区的话题线程查看/回复面板，避免话题消息在主列表铺开造成视觉杂乱
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { animeStagger, cleanupAnime, createTimelineIfMotion } from "@/lib/anime";
import { useLanguage } from "@/lib/i18n";
import { messageList } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import MessageBubble from "./MessageBubble";
import RoomHumanComposer from "./RoomHumanComposer";
import type { DashboardMessage } from "@/lib/types";

const topicStatusColors: Record<string, { color: string; icon: string }> = {
  open:      { color: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",    icon: "●" },
  completed: { color: "text-green-400 bg-green-400/10 border-green-400/30",    icon: "✔" },
  failed:    { color: "text-red-400 bg-red-400/10 border-red-400/30",          icon: "✗" },
  expired:   { color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: "⏱" },
};

const EMPTY_MESSAGES: DashboardMessage[] = [];
const DRAWER_PART_SELECTOR = "[data-topic-drawer-part]";

function getDrawerParts(drawer: HTMLElement | null): HTMLElement[] {
  return drawer ? Array.from(drawer.querySelectorAll<HTMLElement>(DRAWER_PART_SELECTOR)) : [];
}

export default function TopicDrawer() {
  const locale = useLanguage();
  const t = messageList[locale];

  const { openedRoomId, openedTopicId, setOpenedTopicId } = useDashboardUIStore(
    useShallow((state) => ({
      openedRoomId: state.openedRoomId,
      openedTopicId: state.openedTopicId,
      setOpenedTopicId: state.setOpenedTopicId,
    })),
  );
  const messages = useDashboardChatStore(
    (s) => openedRoomId ? (s.messages[openedRoomId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);

  const overlayRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof createTimelineIfMotion>>(null);
  const closingRef = useRef(false);

  const { topicMessages, topicName, topicStatus, topicGoal } = useMemo(() => {
    if (!openedRoomId || !openedTopicId) {
      return { topicMessages: [], topicName: "", topicStatus: null as string | null, topicGoal: null as string | null };
    }
    const filtered = messages.filter((m) => m.topic_id === openedTopicId);
    const first = filtered[0];
    return {
      topicMessages: filtered,
      topicName: first?.topic_title || first?.topic || openedTopicId,
      topicStatus: first?.topic_status || null,
      topicGoal: first?.topic_goal || null,
    };
  }, [messages, openedRoomId, openedTopicId]);

  useEffect(() => {
    if (openedTopicId) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [openedTopicId, topicMessages.length]);

  useLayoutEffect(() => {
    if (!openedRoomId || !openedTopicId) return;

    closingRef.current = false;
    cleanupAnime(animationRef.current);

    const overlay = overlayRef.current;
    const drawer = drawerRef.current;
    const parts = getDrawerParts(drawer);
    if (!drawer) return;

    if (overlay) overlay.style.opacity = "0";
    drawer.style.opacity = "0";
    drawer.style.transform = "translateX(32px)";
    parts.forEach((part) => {
      part.style.opacity = "0";
      part.style.transform = "translateY(8px)";
    });

    const timeline = createTimelineIfMotion({
      onComplete: () => {
        if (animationRef.current === timeline) animationRef.current = null;
      },
    });
    animationRef.current = timeline;

    if (!timeline) {
      if (overlay) overlay.style.opacity = "1";
      drawer.style.opacity = "1";
      drawer.style.transform = "translateX(0px)";
      parts.forEach((part) => {
        part.style.opacity = "1";
        part.style.transform = "translateY(0px)";
      });
      return;
    }

    if (overlay) {
      timeline.add(overlay, {
        opacity: [0, 1],
        duration: 180,
        ease: "linear",
      }, 0);
    }

    timeline.add(drawer, {
      opacity: [0, 1],
      translateX: [32, 0],
      duration: 280,
      ease: "out(3)",
    }, 0);

    if (parts.length) {
      timeline.add(parts, {
        opacity: [0, 1],
        translateY: [8, 0],
        duration: 220,
        delay: animeStagger(28),
        ease: "out(3)",
      }, 90);
    }

    return () => cleanupAnime(timeline);
  }, [openedRoomId, openedTopicId]);

  const closeDrawer = useCallback(() => {
    if (closingRef.current) return;

    const overlay = overlayRef.current;
    const drawer = drawerRef.current;
    const parts = getDrawerParts(drawer);
    if (!drawer) {
      setOpenedTopicId(null);
      return;
    }

    closingRef.current = true;
    animationRef.current?.pause();

    const finishClose = () => {
      closingRef.current = false;
      animationRef.current = null;
      setOpenedTopicId(null);
    };

    const timeline = createTimelineIfMotion({
      onComplete: finishClose,
    });
    animationRef.current = timeline;

    if (!timeline) {
      finishClose();
      return;
    }

    if (parts.length) {
      timeline.add(parts, {
        opacity: 0,
        translateY: -4,
        duration: 110,
        delay: animeStagger(12, { reversed: true }),
        ease: "in(2)",
      }, 0);
    }

    timeline.add(drawer, {
      opacity: 0,
      translateX: 36,
      duration: 180,
      ease: "in(2)",
    }, parts.length ? 35 : 0);

    if (overlay) {
      timeline.add(overlay, {
        opacity: 0,
        duration: 140,
        ease: "linear",
      }, parts.length ? 35 : 0);
    }
  }, [setOpenedTopicId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    if (openedTopicId) {
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
  }, [closeDrawer, openedTopicId]);

  if (!openedRoomId || !openedTopicId) return null;

  const sc = topicStatus ? topicStatusColors[topicStatus] : null;
  const statusLabel = topicStatus
    ? ({ open: t.open, completed: t.completed, failed: t.failed, expired: t.expired } as Record<string, string>)[topicStatus] || topicStatus
    : null;

  return (
    <>
      <div
        ref={overlayRef}
        onClick={closeDrawer}
        className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden"
      />
      <aside
        ref={drawerRef}
        className="fixed right-0 top-0 z-40 flex h-full w-full max-w-[480px] flex-col border-l border-glass-border bg-deep-black shadow-2xl md:w-[440px]"
      >
        <header data-topic-drawer-part className="flex items-start gap-2 border-b border-glass-border/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-text-secondary/60">{t.topic || "Topic"}</span>
              {sc && statusLabel && (
                <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ${sc.color}`}>
                  <span className="text-[8px]">{sc.icon}</span>
                  {statusLabel}
                </span>
              )}
            </div>
            <h2 className="mt-1 truncate text-base font-medium text-text-primary">{topicName}</h2>
            {topicGoal && (
              <p className="mt-1 truncate text-xs text-neon-purple/80">🎯 {topicGoal}</p>
            )}
          </div>
          <button
            onClick={closeDrawer}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            aria-label="Close topic"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div data-topic-drawer-part className="flex-1 overflow-y-auto px-3 py-3">
          {topicMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              {t.noMessages}
            </div>
          ) : (
            topicMessages.map((msg) => (
              <MessageBubble
                key={msg.hub_msg_id}
                message={msg}
                isOwn={msg.sender_id === activeAgentId}
                fullWidth
                sourceId={openedRoomId}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div data-topic-drawer-part className="border-t border-glass-border/60 px-3 py-3">
          <RoomHumanComposer roomId={openedRoomId} topicId={openedTopicId} />
        </div>
      </aside>
    </>
  );
}
