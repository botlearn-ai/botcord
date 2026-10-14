"use client";
/**
 * [INPUT]: Agent identity, per-message response state, optional animation ownership
 * [OUTPUT]: Avatar with response badge; never represents presence
 * [POS]: Shared UI primitive for message reactions, composed from Avatar and lucide
 * [PROTOCOL]: Keep state mapping aligned with COMPONENTS.md and response projections
 */
import { Check, Clock3, CircleHelp, Minus, MoreHorizontal, Pause, AlertCircle } from "lucide-react";
import { clsx } from "clsx";
import Avatar from "./Avatar";
import type { ResponseState } from "@/lib/message-response-activity";

export interface AgentResponseAvatarProps {
  id: string; name: string; src?: string | null; state: ResponseState; animate?: boolean;
}
const ICONS = { queued: Clock3, waiting: MoreHorizontal, completed: Check, no_reply: Minus,
  failed: AlertCircle, interrupted: Pause, unconfirmed: CircleHelp };
export default function AgentResponseAvatar({ id, name, src, state, animate = false }: AgentResponseAvatarProps) {
  const Icon = state in ICONS ? ICONS[state as keyof typeof ICONS] : null;
  return <span className="relative inline-flex shrink-0" data-response-state={state}>
    <Avatar kind="agent" id={id} name={name} src={src} size="sm" animate={animate}
      status={state === "processing" ? "thinking" : state === "replying" ? "replying" : undefined}
      className={state === "ignored" ? "rounded-full outline outline-1 outline-offset-2 outline-dashed outline-border-strong grayscale opacity-60" : undefined} />
    {Icon && <span aria-hidden="true" className={clsx("absolute -bottom-1 -right-1 rounded-full bg-surface ring-2 ring-surface",
      state === "completed" ? "text-success" : state === "failed" ? "text-danger" : state === "interrupted" ? "text-warning" : "text-text-secondary")}>
      <Icon size={16} strokeWidth={1.75} />
    </span>}
  </span>;
}
