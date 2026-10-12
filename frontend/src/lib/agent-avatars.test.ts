import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_AVATAR_CHARACTERS,
  AGENT_AVATAR_HUES,
  AGENT_AVATAR_URLS,
  isAgentAvatarUrl,
  parseAgentAvatarUrl,
} from "./agent-avatars";
import { LEGACY_AGENT_AVATAR_MAP } from "./agent-avatar-legacy";
import { getBotAvatarUrl } from "./bot-avatars";

const publicDir = path.join(process.cwd(), "public");

describe("agent avatars", () => {
  it("ships one SVG per character × hue", () => {
    expect(AGENT_AVATAR_URLS).toHaveLength(AGENT_AVATAR_CHARACTERS.length * AGENT_AVATAR_HUES.length);
    for (const url of AGENT_AVATAR_URLS) {
      expect(existsSync(path.join(publicDir, url)), url).toBe(true);
    }
  });

  it("parses built-in URLs and rejects everything else", () => {
    expect(parseAgentAvatarUrl("/agent-avatars/robot-blue.svg")).toEqual({ character: "robot", hue: "blue" });
    expect(isAgentAvatarUrl("/agent-avatars/7.png")).toBe(false);
    expect(isAgentAvatarUrl("/agent-avatars/pizza-amber.svg")).toBe(false);
    expect(isAgentAvatarUrl("https://example.com/a.svg")).toBe(false);
  });

  it("maps every legacy pixel avatar to a built-in SVG", () => {
    expect(Object.keys(LEGACY_AGENT_AVATAR_MAP)).toHaveLength(43);
    for (const url of Object.values(LEGACY_AGENT_AVATAR_MAP)) {
      expect(isAgentAvatarUrl(url), url).toBe(true);
    }
  });

  it("picks a deterministic default that spreads over characters and hues", () => {
    expect(getBotAvatarUrl("ag_7f3k2m9x")).toBe(getBotAvatarUrl("ag_7f3k2m9x"));
    const picks = Array.from({ length: 400 }, (_, i) => getBotAvatarUrl(`ag_${i.toString(36)}x${i}`));
    picks.forEach((url) => expect(isAgentAvatarUrl(url)).toBe(true));
    const characters = new Set(picks.map((url) => parseAgentAvatarUrl(url)!.character));
    const hues = new Set(picks.map((url) => parseAgentAvatarUrl(url)!.hue));
    expect(characters.size).toBe(AGENT_AVATAR_CHARACTERS.length);
    expect(hues.size).toBe(AGENT_AVATAR_HUES.length);
  });
});
