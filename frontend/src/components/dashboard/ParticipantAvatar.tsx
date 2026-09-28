"use client";

import { useState } from "react";
import BotAvatar from "./BotAvatar";

/** Shared message avatar: profile image first, human initials or the bot pool otherwise. */
export default function ParticipantAvatar({
  id, name, avatarUrl, isHuman, size = 24,
}: {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isHuman: boolean;
  size?: number;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!isHuman) {
    return <BotAvatar agentId={id} avatarUrl={avatarUrl} alt={name} size={size} />;
  }
  if (avatarUrl && avatarUrl !== failedUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={avatarUrl} alt={name} width={size} height={size}
        onError={() => setFailedUrl(avatarUrl)}
        className="shrink-0 rounded-full object-cover ring-1 ring-glass-border"
        style={{ width: size, height: size }} />
    );
  }
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() || "?";
  return (
    <span role="img" aria-label={name} className="inline-flex shrink-0 items-center justify-center rounded-full bg-neon-cyan/15 font-semibold leading-none text-neon-cyan ring-1 ring-glass-border"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}>
      {initial}
    </span>
  );
}
