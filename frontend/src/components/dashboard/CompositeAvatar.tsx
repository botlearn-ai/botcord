"use client";

import type { RoomMemberPreview } from "@/lib/types";
import { getBotAvatarUrl } from "@/lib/bot-avatars";

/**
 * 2×2 composite avatar for group rooms.
 * - First three cells show member avatars.
 * - Bottom-right cell always shows how many other members are in the room.
 */
export function CompositeAvatar({
  members,
  totalMembers,
  size = 40,
}: {
  members: RoomMemberPreview[];
  totalMembers: number;
  size?: number;
}) {
  const visible = members.slice(0, 3);
  const overflow = Math.max(0, totalMembers - 3);

  const slots: Array<{ kind: "member"; member: RoomMemberPreview } | { kind: "overflow"; count: number } | { kind: "empty" }> = [];
  for (let i = 0; i < 3; i += 1) {
    const member = visible[i];
    slots.push(member ? { kind: "member", member } : { kind: "empty" });
  }
  slots.push({ kind: "overflow", count: overflow });

  return (
    <div
      className="grid shrink-0 grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-xl border border-glass-border bg-deep-black-light p-0.5"
      style={{ width: size, height: size }}
      aria-label={`Group of ${totalMembers} members`}
    >
      {slots.map((slot, i) => {
        if (slot.kind === "member") {
          // Prefer real avatars when the API has one. Bot members fall back to
          // the deterministic local bot avatar pool; humans fall back to initials.
          const avatarUrl = slot.member.avatar_url || (
            slot.member.agent_id ? getBotAvatarUrl(slot.member.agent_id) : null
          );
          if (avatarUrl) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={avatarUrl}
                alt={slot.member.display_name}
                title={slot.member.display_name}
                className="h-full w-full rounded-md object-cover"
              />
            );
          }
          const tone = toneFor(slot.member.display_name, i);
          return (
            <div
              key={i}
              className={`flex items-center justify-center rounded-md text-[9px] font-semibold leading-none ${tone}`}
              title={slot.member.display_name}
            >
              {(slot.member.display_name || "?").charAt(0).toUpperCase()}
            </div>
          );
        }
        if (slot.kind === "overflow") {
          return (
            <div
              key={i}
              className="flex items-center justify-center rounded-md bg-glass-bg text-[9px] font-semibold text-text-secondary"
            >
              +{slot.count}
            </div>
          );
        }
        return <div key={i} className="rounded-md bg-glass-bg/30" />;
      })}
    </div>
  );
}

const tonePalette = [
  "bg-neon-cyan/15 text-neon-cyan",
  "bg-neon-purple/15 text-neon-purple",
  "bg-neon-green/15 text-neon-green",
  "bg-orange-400/15 text-orange-300",
];

function toneFor(seed: string, fallbackIndex: number): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return tonePalette[(hash || fallbackIndex) % tonePalette.length];
}
