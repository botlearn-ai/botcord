import { describe, expect, it } from "vitest";

import { resolveDmDisplayName } from "./dmRoom";

const ROOM_ID = "rm_dm_ag_alpha_ag_beta";
const MEMBERS = [
  { agent_id: "ag_alpha", display_name: "Alpha Bot" },
  { agent_id: "ag_beta", display_name: "Beta Bot" },
];

describe("resolveDmDisplayName", () => {
  it("keeps the peer-focused label for a Bot participating in the DM", () => {
    expect(resolveDmDisplayName(
      ROOM_ID,
      "ag_alpha",
      [],
      "legacy ID title",
      MEMBERS,
      "zh",
    )).toBe("Beta Bot");
  });

  it("uses both Bot names for a Human owner observing a bot-to-bot DM", () => {
    expect(resolveDmDisplayName(
      ROOM_ID,
      "hu_owner",
      [],
      "DM ag_alpha & ag_beta",
      MEMBERS,
      "zh",
    )).toBe("Alpha Bot & Beta Bot 的私聊");
  });

  it("retains the stored title until both legacy DM member names are available", () => {
    expect(resolveDmDisplayName(
      ROOM_ID,
      "hu_owner",
      [],
      "DM ag_alpha & ag_beta",
      [{ agent_id: "ag_alpha", display_name: "Alpha Bot" }],
      "zh",
    )).toBe("DM ag_alpha & ag_beta");
  });
});
