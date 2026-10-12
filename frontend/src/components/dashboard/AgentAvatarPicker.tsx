"use client";

import IconButton from "@/components/ui/IconButton";
import Card from "@/components/ui/Card";

/**
 * [INPUT]: 依赖 lib/agent-avatars 的 16 角色 × 8 色内置头像
 * [OUTPUT]: 对外提供 AgentAvatarPicker：上方 8 个颜色色块，下方 16 个角色（按当前颜色预览）
 * [POS]: dashboard 头像选择原语，供 AgentProfileEditModal 与 AgentSettingsDrawer 复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md；头像规范见 docs/brand/botcord-vi/VI.md §6
 */

import { useState } from "react";
import {
  AGENT_AVATAR_CHARACTERS,
  AGENT_AVATAR_HUE_COLORS,
  AGENT_AVATAR_HUES,
  agentAvatarUrl,
  parseAgentAvatarUrl,
} from "@/lib/agent-avatars";
import type { AgentAvatarHue } from "@/lib/agent-avatars";

interface AgentAvatarPickerProps {
  value: string | null | undefined;
  onChange: (url: string) => void;
  disabled?: boolean;
  /** Accessible labels; the picker itself has no visible text. */
  colorLabel: string;
  avatarLabel: string;
}

export default function AgentAvatarPicker({ value, onChange, disabled, colorLabel, avatarLabel }: AgentAvatarPickerProps) {
  const selected = parseAgentAvatarUrl(value);
  // The previewed hue follows the saved value (which may load after mount) until the user picks a colour.
  const [pickedHue, setPickedHue] = useState<AgentAvatarHue | null>(null);
  const hue = pickedHue ?? selected?.hue ?? "cyan";

  function pickHue(next: AgentAvatarHue) {
    setPickedHue(next);
    // Recolour the current character straight away so a colour click is a real change.
    if (selected) onChange(agentAvatarUrl(selected.character, next));
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={colorLabel}>
        {AGENT_AVATAR_HUES.map((h) => (
          <IconButton key={h} label={h} role="radio" aria-checked={h === hue} disabled={disabled} onClick={() => pickHue(h)}>
            <span className="h-6 w-6 rounded-full border border-border" style={{ backgroundColor: AGENT_AVATAR_HUE_COLORS[h], outline: h === hue ? "2px solid var(--bc-accent)" : undefined, outlineOffset: 3 }} />
          </IconButton>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8" role="radiogroup" aria-label={avatarLabel}>
        {AGENT_AVATAR_CHARACTERS.map((character) => {
          const url = agentAvatarUrl(character, hue);
          const isSelected = selected?.character === character && selected.hue === hue;
          return (
            <Card as="button" variant="interactive" padding="sm"
              key={character}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={character}
              disabled={disabled}
              onClick={() => onChange(url)}

            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt="" className="aspect-square w-full" />
            </Card>
          );
        })}
      </div>
    </div>
  );
}
