/**
 * [INPUT]: 依赖 lib/bot-avatars 的 getBotAvatarUrl、SignalDot、VI 颜色语义类、styles/ui-motion.css 的 bc-avatar-orbit 与 clsx
 * [OUTPUT]: 对外提供 Avatar：agent / human / room 三种身份头像，xs–xl 五种尺寸（20 / 28 / 36 / 48 / 64px），agent 可带状态信号点
 * [POS]: ui 身份原语；BotAvatar / ParticipantAvatar 迁移后的统一头像实现，新代码直接用它
 * [PROTOCOL]: animate=false 保留状态并停用动效； 变更时更新此头部，然后检查 README.md；形状与状态以 docs/brand/botcord-vi/VI.md §6.1、§6.3 为准
 */

"use client";

import { useState } from "react";
import { clsx } from "clsx";
import { getBotAvatarUrl } from "@/lib/bot-avatars";
import SignalDot from "./SignalDot";
import type { AgentSignal, SignalDotSize } from "./SignalDot";

export type AvatarKind = "agent" | "human" | "room";
export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE: Record<AvatarSize, { box: string; text: string; dot: SignalDotSize }> = {
  xs: { box: "h-5 w-5", text: "text-xs", dot: "xs" },
  sm: { box: "h-7 w-7", text: "text-xs", dot: "xs" },
  md: { box: "h-9 w-9", text: "text-sm", dot: "sm" },
  lg: { box: "h-12 w-12", text: "text-lg", dot: "md" },
  xl: { box: "h-16 w-16", text: "text-2xl", dot: "md" },
};

// VI §6.1: agent circle, human 30% rounded square, room 24% rounded square.
const SHAPE: Record<AvatarKind, string> = {
  agent: "rounded-full",
  human: "rounded-[30%]",
  room: "rounded-[24%]",
};

export interface AvatarProps {
  kind: AvatarKind;
  /** Agent id picks the default avatar when there is no image. */
  id: string;
  /** Used as alt / aria-label; human and room fall back to its first letter. */
  name: string;
  src?: string | null;
  size?: AvatarSize;
  /** Only rendered for agents. */
  status?: AgentSignal;
  /** Keep status visible without starting another loop in a dense message list. */
  animate?: boolean;
  /**
   * Legacy escape hatch for call sites that size avatars in raw pixels
   * (BotAvatar / ParticipantAvatar). New code should use `size`.
   */
  pixelSize?: number;
  className?: string;
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() || "?";
}

export default function Avatar({ kind, id, name, src, size = "md", status, animate = true, pixelSize, className }: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const sizing = SIZE[size];
  const shape = SHAPE[kind];

  const customUrl = src && src !== failedUrl ? src : null;
  // Agents always have an image (default pool); humans and rooms fall back to initials.
  const url = kind === "agent" ? customUrl || getBotAvatarUrl(id) : customUrl;
  const showStatus = kind === "agent" && status !== undefined;

  return (
    <span
      data-kind={kind}
      className={clsx("relative inline-flex shrink-0", pixelSize === undefined && sizing.box, className)}
      style={pixelSize === undefined ? undefined : { width: pixelSize, height: pixelSize }}
    >
      {showStatus && status === "replying" ? (
        // VI §6.3: a cord arc turns around the avatar while the agent replies.
        <svg aria-hidden="true" viewBox="0 0 50 50" fill="none" className="bc-avatar-orbit pointer-events-none absolute -inset-1" style={animate ? undefined : { animation: "none" }}>
          <circle cx={25} cy={25} r={23} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="28 117" className="stroke-brand" />
        </svg>
      ) : null}
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={name}
          onError={customUrl ? () => setFailedUrl(customUrl) : undefined}
          className={clsx("h-full w-full object-cover ring-1 ring-border", shape)}
        />
      ) : (
        <span
          role="img"
          aria-label={name}
          className={clsx(
            "inline-flex h-full w-full items-center justify-center bg-accent-soft font-semibold leading-none text-accent-text ring-1 ring-border",
            shape,
            pixelSize === undefined && sizing.text,
          )}
          style={pixelSize === undefined ? undefined : { fontSize: Math.round(pixelSize * 0.45) }}
        >
          {initialOf(name)}
        </span>
      )}
      {showStatus ? (
        // Wrapper owns the positioning so it does not fight SignalDot's own `relative`.
        <span className="absolute -right-px -top-px inline-flex">
          <SignalDot status={status} size={sizing.dot} animate={animate} className="ring-2 ring-surface" />
        </span>
      ) : null}
    </span>
  );
}
