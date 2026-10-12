"use client";

import Avatar from "@/components/ui/Avatar";

interface BotAvatarProps {
  agentId: string;
  avatarUrl?: string | null;
  /** Pixel size — controls both width and height. */
  size?: number;
  /** Optional alt text (defaults to agent name if provided). */
  alt?: string;
  className?: string;
  /** Ignored: VI v1.0 draws every agent as a circle. Kept for call-site compatibility. */
  shape?: "circle" | "rounded";
}

/** Legacy wrapper around `ui/Avatar` (kind="agent"). New code should use Avatar directly. */
export default function BotAvatar({ agentId, avatarUrl, size = 40, alt, className = "" }: BotAvatarProps) {
  return (
    <Avatar
      kind="agent"
      id={agentId}
      name={alt || `Bot ${agentId}`}
      src={avatarUrl}
      pixelSize={size}
      className={className}
    />
  );
}
