"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useShallow } from "zustand/react/shallow";
import { animateIfMotion, cleanupAnime } from "@/lib/anime";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { PresenceDot } from "./PresenceDot";

type MotionAnimation = ReturnType<typeof animateIfMotion>;
const mentionClassName = "inline max-w-full rounded-none border-0 bg-transparent p-0 align-baseline font-medium leading-[inherit] text-neon-cyan underline decoration-neon-cyan/45 underline-offset-2 transition-colors hover:text-neon-cyan/80 hover:decoration-neon-cyan disabled:cursor-default";

export default function MentionChip({
  id,
  label,
  prefix = "@",
  onSelectAgent,
  onSelectHuman,
}: {
  id: string;
  label: string;
  prefix?: string;
  onSelectAgent?: (agentId: string) => void;
  onSelectHuman?: (humanId: string, displayName: string) => void;
}) {
  const selectAgent = useDashboardChatStore((state) => state.selectAgent);
  const openHuman = useDashboardUIStore((state) => state.requestOpenHuman);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipAnimationRef = useRef<MotionAnimation>(null);
  const tooltipOpenedRef = useRef(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const tooltipOpen = Boolean(tooltipPosition);
  const isHuman = id.startsWith("hu_");
  const isAgent = id.startsWith("ag_");
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  // Narrow subscription: derive only the primitive name/bio fields for this id,
  // so the chip re-renders only when *those* change — not on every overview /
  // publicAgents churn (which fires on every inbound message).
  const { contactAlias, contactDisplayName, publicAgentDisplayName, publicAgentBio } =
    useDashboardChatStore(
      useShallow((state) => {
        const contact = state.overview?.contacts.find((item) => item.contact_agent_id === id);
        const publicAgent = state.publicAgents.find((agent) => agent.agent_id === id);
        return {
          contactAlias: contact?.alias ?? null,
          contactDisplayName: contact?.display_name ?? null,
          publicAgentDisplayName: publicAgent?.display_name ?? null,
          publicAgentBio: publicAgent?.bio ?? null,
        };
      }),
    );

  const ownAgent = ownedAgents.find((agent) => agent.agent_id === id);
  const displayName = contactAlias || ownAgent?.display_name || contactDisplayName || publicAgentDisplayName || label;
  const bio = ownAgent?.bio ?? publicAgentBio ?? null;
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

  useLayoutEffect(() => {
    if (!tooltipOpen) {
      tooltipOpenedRef.current = false;
      cleanupAnime(tooltipAnimationRef.current);
      tooltipAnimationRef.current = null;
      return;
    }

    if (tooltipOpenedRef.current) return;
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    tooltipOpenedRef.current = true;
    cleanupAnime(tooltipAnimationRef.current);
    tooltip.style.opacity = "0";
    tooltip.style.transform = "translateY(4px) scale(0.98)";
    tooltip.style.transformOrigin = "top left";

    const animation = animateIfMotion(tooltip, {
      opacity: [0, 1],
      translateY: [4, 0],
      scale: [0.98, 1],
      duration: 170,
      ease: "out(3)",
    });
    tooltipAnimationRef.current = animation;

    if (!animation) {
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0px) scale(1)";
      return;
    }

    return () => {
      tooltipOpenedRef.current = false;
      cleanupAnime(tooltipAnimationRef.current);
      tooltipAnimationRef.current = null;
    };
  }, [tooltipOpen]);

  const handleClick = () => {
    if (isHuman) {
      (onSelectHuman ?? openHuman)(id, displayName);
      return;
    }
    if (isAgent) {
      (onSelectAgent ?? selectAgent)(id);
    }
  };

  if (id.startsWith("rm_")) {
    return <Link href={`/chats/messages/${encodeURIComponent(id)}`} data-mention-id={id} className={mentionClassName} onClick={(event) => event.stopPropagation()}>{prefix}{displayName}</Link>;
  }

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
        data-mention-id={id}
        className={mentionClassName}
      >
        {prefix}{displayName}
      </button>
      {tooltipPosition && typeof document !== "undefined" && createPortal(
        <span
          ref={tooltipRef}
          className="liquid-menu pointer-events-none fixed z-[900] w-64 rounded-xl border border-glass-border bg-deep-black-light p-3 text-left shadow-xl shadow-black/30"
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
