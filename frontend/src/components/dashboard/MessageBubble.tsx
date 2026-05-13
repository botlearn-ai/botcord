"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Bot, MoreHorizontal, User } from "lucide-react";
import ForwardModal from "./ForwardModal";
import type { DashboardMessage, Attachment } from "@/lib/types";
import { useLanguage } from '@/lib/i18n';
import { messageBubble } from '@/lib/i18n/translations/dashboard';
import AttachmentItem from "@/components/ui/AttachmentItem";
import CopyableId from "@/components/ui/CopyableId";
import MarkdownContent from "@/components/ui/MarkdownContent";
import type { MentionTextCandidate } from "@/components/ui/MarkdownContent";
import SystemMessageNotice from "@/components/ui/SystemMessageNotice";
import TransferCard, { parseTransferText, parseTransferNotice } from "@/components/dashboard/TransferCard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import BotAvatar from "./BotAvatar";
import { PresenceDot } from "./PresenceDot";

interface MessageBubbleProps {
  message: DashboardMessage;
  isOwn: boolean;
  /** When true, the bubble fills the container width instead of capping at 70%. */
  fullWidth?: boolean;
  /** Source label shown in the forward quote (e.g. room name or chat name). */
  sourceName?: string;
  /** Source room_id or DM agent_id included in the forward quote for AI context. */
  sourceId?: string;
  /** Known participants used to resolve plain-text @display-name mentions. */
  mentionCandidates?: MentionTextCandidate[];
}

const stateColors: Record<string, { color: string; icon: string }> = {
  queued:    { color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: "⏳" },
  delivered: { color: "text-blue-400 bg-blue-400/10 border-blue-400/30",     icon: "✓" },
  acked:     { color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30", icon: "✓✓" },
  done:      { color: "text-green-400 bg-green-400/10 border-green-400/30",   icon: "✔" },
  failed:    { color: "text-red-400 bg-red-400/10 border-red-400/30",         icon: "✗" },
};

const showMessageStatus = (() => {
  const raw = process.env.SHOW_MESSAGE_STATUS ?? process.env.NEXT_PUBLIC_SHOW_MESSAGE_STATUS;
  if (!raw) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
})();

function useStateConfig() {
  const locale = useLanguage();
  const t = messageBubble[locale];
  const labels: Record<string, string> = {
    queued: t.queued,
    delivered: t.delivered,
    acked: t.acked,
    done: t.done,
    failed: t.failed,
  };
  const config: Record<string, { label: string; color: string; icon: string }> = {};
  for (const [key, val] of Object.entries(stateColors)) {
    config[key] = { label: labels[key] || key, ...val };
  }
  return config;
}

function StateCountsBadges({ counts }: { counts: Record<string, number> }) {
  const stateConfig = useStateConfig();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const order = ["done", "acked", "delivered", "queued", "failed"];
  const entries = order
    .filter((s) => counts[s] && counts[s] > 0)
    .map((s) => ({ state: s, count: counts[s] }));

  return (
    <span className="inline-flex items-center gap-1">
      {entries.map(({ state, count }) => {
        const sc = stateConfig[state];
        if (!sc) return null;
        return (
          <span
            key={state}
            className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${sc.color}`}
          >
            <span className="text-[8px]">{sc.icon}</span>
            {count}/{total} {sc.label}
          </span>
        );
      })}
    </span>
  );
}

function formatMessageTimestamp(isoTime: string): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return "";

  const ageMs = Date.now() - date.getTime();
  if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function MentionChip({
  id,
  label,
  prefix = "@",
  onSelectAgent,
  onSelectHuman,
}: {
  id: string;
  label: string;
  prefix?: string;
  onSelectAgent: (agentId: string) => void;
  onSelectHuman: (humanId: string, displayName: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const isHuman = id.startsWith("hu_");
  const isAgent = id.startsWith("ag_");
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  const overview = useDashboardChatStore((state) => state.overview);
  const publicAgents = useDashboardChatStore((state) => state.publicAgents);

  const ownAgent = ownedAgents.find((agent) => agent.agent_id === id);
  const contact = overview?.contacts.find((item) => item.contact_agent_id === id);
  const publicAgent = publicAgents.find((agent) => agent.agent_id === id);
  const displayName = contact?.alias || ownAgent?.display_name || contact?.display_name || publicAgent?.display_name || label;
  const bio = ownAgent?.bio ?? publicAgent?.bio ?? null;
  const role = isHuman ? "Human" : isAgent ? "Agent" : "Mention";
  const canOpen = isHuman || isAgent;

  const updateTooltipPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const tooltipWidth = 256;
    const estimatedTooltipHeight = bio ? 128 : 92;
    const gap = 6;
    const viewportPadding = 8;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipWidth - viewportPadding);
    const left = Math.min(Math.max(rect.left, viewportPadding), maxLeft);
    const spaceAbove = rect.top - viewportPadding;
    const spaceBelow = window.innerHeight - rect.bottom - viewportPadding;
    const shouldPlaceBelow = spaceAbove < estimatedTooltipHeight && spaceBelow >= spaceAbove;
    const top = shouldPlaceBelow
      ? Math.min(rect.bottom + gap, window.innerHeight - estimatedTooltipHeight - viewportPadding)
      : Math.max(viewportPadding, rect.top - estimatedTooltipHeight - gap);

    setTooltipPosition((prev) => (
      prev && prev.left === left && prev.top === top ? prev : { left, top }
    ));
  }, [bio]);

  useLayoutEffect(() => {
    if (!tooltipPosition) return;

    updateTooltipPosition();
    window.addEventListener("resize", updateTooltipPosition);
    window.addEventListener("scroll", updateTooltipPosition, true);

    return () => {
      window.removeEventListener("resize", updateTooltipPosition);
      window.removeEventListener("scroll", updateTooltipPosition, true);
    };
  }, [tooltipPosition, updateTooltipPosition]);

  const handleClick = () => {
    if (isHuman) {
      onSelectHuman(id, displayName);
      return;
    }
    if (isAgent) {
      onSelectAgent(id);
    }
  };

  return (
    <span className="inline align-baseline">
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={updateTooltipPosition}
        onMouseLeave={() => setTooltipPosition(null)}
        onFocus={updateTooltipPosition}
        onBlur={() => setTooltipPosition(null)}
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
        disabled={!canOpen}
        className="inline max-w-full rounded-none border-0 bg-transparent p-0 align-baseline font-medium leading-[inherit] text-neon-cyan underline decoration-neon-cyan/45 underline-offset-2 transition-colors hover:text-neon-cyan/80 hover:decoration-neon-cyan disabled:cursor-default"
      >
        {prefix}{displayName}
      </button>
      {tooltipPosition && typeof document !== "undefined" && createPortal(
        <span
          className="pointer-events-none fixed z-[9999] w-64 rounded-lg border border-glass-border bg-zinc-950/95 p-3 text-left shadow-xl shadow-black/30"
          style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
        >
          <span className="mb-1 flex items-center gap-2">
            {isAgent && <PresenceDot agentId={id} size="sm" />}
            <span className={`truncate text-xs font-semibold ${isHuman ? "text-neon-green" : "text-neon-purple"}`}>
              {displayName}
            </span>
            <span className="ml-auto rounded border border-glass-border px-1.5 py-0.5 text-[10px] text-text-secondary">
              {role}
            </span>
          </span>
          <span className="block truncate font-mono text-[10px] text-text-secondary/70">{id}</span>
          {bio && <span className="mt-1.5 line-clamp-3 block text-xs leading-relaxed text-text-secondary">{bio}</span>}
        </span>,
        document.body,
      )}
    </span>
  );
}

function getSystemJoinParticipant(payload: Record<string, unknown>): { id: string; name: string } | null {
  if (payload.subtype !== "room_member_joined") return null;
  if (typeof payload.participant_id !== "string" || typeof payload.participant_name !== "string") return null;
  return { id: payload.participant_id, name: payload.participant_name };
}

function SenderAvatar({
  senderId,
  displayName,
  avatarUrl,
  isHuman,
  onClick,
  onKeyDown,
}: {
  senderId: string;
  displayName: string;
  avatarUrl?: string | null;
  isHuman: boolean;
  onClick: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      onKeyDown={onKeyDown}
      className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full focus:outline-none focus:ring-2 focus:ring-neon-cyan/50"
      title={displayName}
      aria-label={`Open ${displayName}`}
    >
      {isHuman ? (
        avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={displayName}
            width={32}
            height={32}
            className="h-8 w-8 rounded-full object-cover ring-1 ring-neon-green/30"
          />
        ) : (
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-neon-green/30 bg-neon-green/10 text-neon-green">
            <User className="h-4 w-4" />
          </span>
        )
      ) : (
        <BotAvatar
          agentId={senderId}
          avatarUrl={avatarUrl}
          alt={displayName}
          size={32}
          className="ring-neon-purple/30"
        />
      )}
    </div>
  );
}

export default function MessageBubble({ message, isOwn: isOwnProp, fullWidth = false, sourceName, sourceId, mentionCandidates }: MessageBubbleProps) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [forwardQuote, setForwardQuote] = useState<string | null>(null);
  const selectAgent = useDashboardChatStore((state) => state.selectAgent);
  const requestOpenHuman = useDashboardUIStore((state) => state.requestOpenHuman);
  const stateConfig = useStateConfig();
  const textContent = message.payload?.text || message.payload?.body || message.payload?.message;
  const displayText = typeof textContent === "string" ? textContent : message.text;
  const timestampLabel = formatMessageTimestamp(message.created_at);
  const isOwn = typeof message.is_mine === "boolean" ? message.is_mine : isOwnProp;
  const isHuman = message.sender_kind === "human";
  const senderDisplayName = message.display_sender_name || message.sender_name || message.sender_id;

  if (message.type === "system") {
    const joinParticipant = getSystemJoinParticipant(message.payload);
    if (displayText && joinParticipant) {
      const nameIndex = displayText.indexOf(joinParticipant.name);
      if (nameIndex >= 0) {
        const before = displayText.slice(0, nameIndex);
        const after = displayText.slice(nameIndex + joinParticipant.name.length);

        return (
          <SystemMessageNotice timestamp={timestampLabel}>
            {before}
            <MentionChip
              id={joinParticipant.id}
              label={joinParticipant.name}
              prefix=""
              onSelectAgent={selectAgent}
              onSelectHuman={requestOpenHuman}
            />
            {after}
          </SystemMessageNotice>
        );
      }
    }

    return <SystemMessageNotice text={displayText || "System update"} timestamp={timestampLabel} />;
  }

  const transferInfo = displayText
    ? parseTransferText(displayText) ?? parseTransferNotice(displayText, message.payload)
    : null;

  const attachments = Array.isArray(message.payload?.attachments)
    ? (message.payload.attachments as Attachment[])
    : [];

  const sc = stateConfig[message.state];
  const handleSelectSender = () => {
    if (isHuman) {
      requestOpenHuman(message.sender_id, senderDisplayName);
    } else {
      selectAgent(message.sender_id);
    }
  };

  const handleSelectSenderByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleSelectSender();
    }
  };

  const buildQuote = () => {
    const time = formatMessageTimestamp(message.created_at);
    const source = sourceName ? ` · ${sourceName}` : "";
    const id = sourceId ? ` · id:${sourceId}` : "";
    const header = `> [转发自 ${senderDisplayName}${source}${id} · ${time}]`;
    const body = (displayText || "").split("\n").map((l) => `> ${l}`).join("\n");
    return `${header}\n${body}\n`;
  };

  const handleForwardClick = () => {
    setMenuOpen(false);
    if (displayText) setForwardQuote(buildQuote());
  };

  const sideAvatar = !fullWidth && (
    <SenderAvatar
      senderId={message.sender_id}
      displayName={senderDisplayName}
      avatarUrl={message.sender_avatar_url}
      isHuman={isHuman}
      onClick={handleSelectSender}
      onKeyDown={handleSelectSenderByKey}
    />
  );

  const moreButton = displayText && (
    <div className="relative self-start pt-1 shrink-0">
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={`flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 transition-colors ${hovered || menuOpen ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        aria-label="More actions"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {menuOpen && (
        <div className={`absolute top-full mt-1 z-30 min-w-[80px] rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl ${isOwn ? "right-0" : "left-0"}`}>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleForwardClick(); }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
          >
            转发
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
    <div
      className={`flex items-start gap-2 ${isOwn && !fullWidth ? "justify-end" : "justify-start"} mb-2`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setMenuOpen(false); }}
    >
      {/* For own messages: button left of bubble */}
      {isOwn && !fullWidth && moreButton}
      {!isOwn && sideAvatar}
      <div
        className={`${fullWidth ? "w-full" : "max-w-[70%]"} rounded-xl px-3 py-2 ${
          isOwn
            ? "border border-neon-cyan/30 bg-neon-cyan/5"
            : "border border-glass-border bg-glass-bg"
        }`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.stopPropagation(); handleSelectSender(); }}
          onKeyDown={handleSelectSenderByKey}
          className={`mb-0.5 flex items-center gap-1.5 rounded px-1 transition-colors hover:bg-glass-bg ${isOwn ? "justify-end" : "-ml-1"}`}
        >
          <span
            className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
              isHuman
                ? "border-neon-green/30 bg-neon-green/10 text-neon-green"
                : "border-neon-purple/30 bg-neon-purple/10 text-neon-purple"
            }`}
            title={isHuman ? "Human" : "Bot"}
            aria-label={isHuman ? "Human sender" : "Bot sender"}
          >
            {isHuman ? <User className="h-2.5 w-2.5" /> : <Bot className="h-2.5 w-2.5" />}
          </span>
          {!isHuman && <PresenceDot agentId={message.sender_id} size="xs" />}
          <span
            className={`text-xs font-medium hover:underline ${
              isHuman ? "text-neon-green" : "text-neon-purple"
            }`}
          >
            {senderDisplayName}
          </span>
          {!isHuman && <CopyableId value={message.sender_id} />}
        </div>

        {/* Goal badge */}
        {message.goal && (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-lg border border-neon-purple/20 bg-neon-purple/5 px-2 py-1.5">
            <span className="mt-px text-xs text-neon-purple/70">🎯</span>
            <span className="text-xs leading-relaxed text-neon-purple/90">{message.goal}</span>
          </div>
        )}

        {transferInfo ? (
          <TransferCard info={transferInfo} isNotice={displayText?.startsWith("[BotCord Notice]")} />
        ) : (
          displayText && (
            <MarkdownContent
              content={displayText}
              mentionCandidates={mentionCandidates}
              renderMention={({ id, label }) => (
                <MentionChip
                  id={id}
                  label={label}
                  onSelectAgent={selectAgent}
                  onSelectHuman={requestOpenHuman}
                />
              )}
            />
          )
        )}

        {attachments.length > 0 && (
          <div className="mt-1.5 flex flex-col gap-1.5">
            {attachments.map((att, i) => (
              <AttachmentItem key={`${att.filename}-${i}`} attachment={att} />
            ))}
          </div>
        )}

        {/* Footer: time + type + state */}
        <div className={`mt-1 flex items-center gap-1.5 ${isOwn ? "justify-end" : ""}`}>
          <span className="font-mono text-[10px] text-text-secondary/50">
            {timestampLabel}
          </span>
          {message.type !== "message" && (
            <span className="rounded bg-glass-bg px-1 font-mono text-[10px] text-text-secondary/70">
              {message.type}
            </span>
          )}
          {showMessageStatus && (
            <>
              {message.state_counts && Object.keys(message.state_counts).length > 0 ? (
                <StateCountsBadges counts={message.state_counts} />
              ) : sc ? (
                <span className={`inline-flex items-center gap-0.5 rounded border px-1 py-px text-[10px] font-medium ${sc.color}`}>
                  <span className="text-[8px]">{sc.icon}</span>
                  {sc.label}
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>
      {isOwn && sideAvatar}
      {/* For others' messages: button right of bubble */}
      {(!isOwn || fullWidth) && moreButton}
    </div>
    {forwardQuote && (
      <ForwardModal quoteText={forwardQuote} onClose={() => setForwardQuote(null)} />
    )}
    </>
  );
}
