"use client";

import type { RoomMemberPreview } from "@/lib/types";
import { getBotAvatarUrl } from "@/lib/bot-avatars";

/**
 * 2×2 composite avatar for group rooms.
 * - 1-2 members: single avatar fills the box.
 * - 3 members: three small avatars (top-left, top-right, bottom-left).
 * - 4 members: four small avatars filling all corners.
 * - 5+ members: top-left, top-right, bottom-left avatars; bottom-right shows `+N`
 *   where N = totalMembers - 3.
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
  const visible = members.slice(0, 4);
  const overflow = Math.max(0, totalMembers - 3);
  const showOverflow = totalMembers > 4;

  // Cell layout for up to 3 visible + overflow vs. 4 visible.
  // We always render a 2×2 grid; empty slots are blank.
  const slots: Array<{ kind: "member"; member: RoomMemberPreview } | { kind: "overflow"; count: number } | { kind: "empty" }> = [];
  if (showOverflow) {
    slots.push({ kind: "member", member: visible[0] });
    slots.push({ kind: "member", member: visible[1] });
    slots.push({ kind: "member", member: visible[2] });
    slots.push({ kind: "overflow", count: overflow });
  } else if (visible.length === 4) {
    visible.forEach((m) => slots.push({ kind: "member", member: m }));
  } else if (visible.length === 3) {
    slots.push({ kind: "member", member: visible[0] });
    slots.push({ kind: "member", member: visible[1] });
    slots.push({ kind: "member", member: visible[2] });
    slots.push({ kind: "empty" });
  } else if (visible.length === 2) {
    slots.push({ kind: "member", member: visible[0] });
    slots.push({ kind: "member", member: visible[1] });
    slots.push({ kind: "empty" });
    slots.push({ kind: "empty" });
  } else if (visible.length === 1) {
    slots.push({ kind: "member", member: visible[0] });
    slots.push({ kind: "empty" });
    slots.push({ kind: "empty" });
    slots.push({ kind: "empty" });
  } else {
    slots.push({ kind: "empty" }, { kind: "empty" }, { kind: "empty" }, { kind: "empty" });
  }

  return (
    <div
      className="grid shrink-0 grid-cols-2 grid-rows-2 gap-0.5 overflow-hidden rounded-xl border border-glass-border bg-deep-black-light p-0.5"
      style={{ width: size, height: size }}
      aria-label={`Group of ${totalMembers} members`}
    >
      {slots.map((slot, i) => {
        if (slot.kind === "member") {
          // Bot members (have agent_id) → use the bot avatar image so the
          // group icon shows real faces. Humans fall back to the letter chip.
          if (slot.member.agent_id) {
            return (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={getBotAvatarUrl(slot.member.agent_id)}
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
