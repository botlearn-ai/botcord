"use client";

import { getBotAvatarUrl } from "@/lib/bot-avatars";

interface BotAvatarProps {
  agentId: string;
  avatarUrl?: string | null;
  /** Pixel size — controls both width and height. */
  size?: number;
  /** Optional alt text (defaults to agent name if provided). */
  alt?: string;
  className?: string;
  /** Override the rounded radius. Defaults to "rounded-full". */
  shape?: "circle" | "rounded";
}

export default function BotAvatar({
  agentId,
  avatarUrl,
  size = 40,
  alt,
  className = "",
  shape = "circle",
}: BotAvatarProps) {
  const url = avatarUrl || getBotAvatarUrl(agentId);
  const radius = shape === "circle" ? "rounded-full" : "rounded-xl";
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt || `Bot ${agentId}`}
      width={size}
      height={size}
      className={`shrink-0 ${radius} object-cover ring-1 ring-glass-border ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
