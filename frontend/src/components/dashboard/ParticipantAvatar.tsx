"use client";

import Avatar from "@/components/ui/Avatar";

/**
 * Shared message avatar: profile image first, human initials or the bot pool
 * otherwise. Legacy wrapper around `ui/Avatar`; new code should use Avatar.
 */
export default function ParticipantAvatar({
  id, name, avatarUrl, isHuman, size = 24,
}: {
  id: string;
  name: string;
  avatarUrl?: string | null;
  isHuman: boolean;
  size?: number;
}) {
  return <Avatar kind={isHuman ? "human" : "agent"} id={id} name={name} src={avatarUrl} pixelSize={size} />;
}
