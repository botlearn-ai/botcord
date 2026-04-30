import { describe, expect, it } from "vitest";
import { buildMentionCandidates } from "./useMentionCandidates";

describe("buildMentionCandidates", () => {
  it("can scope group mentions to current room members only", () => {
    const candidates = buildMentionCandidates({
      includeAll: true,
      selfId: "hu_self",
      currentRoomId: "rm_current",
      sources: ["roomMembers"],
      ownedAgents: [
        { agent_id: "ag_owned", display_name: "Owned Agent" },
      ],
      contacts: [
        { contact_agent_id: "hu_contact", alias: null, display_name: "Contact" },
      ],
      rooms: [
        { room_id: "rm_other", name: "Other Room" },
      ],
      roomMembers: [
        { agent_id: "hu_self", display_name: "Me" },
        { agent_id: "hu_member", display_name: "Human Member" },
        { agent_id: "ag_member", display_name: "Agent Member" },
      ],
    });

    expect(candidates.map((c) => c.agent_id)).toEqual([
      "@all",
      "hu_member",
      "ag_member",
    ]);
  });

  it("keeps the broad legacy picker when sources are not supplied", () => {
    const candidates = buildMentionCandidates({
      currentRoomId: "rm_current",
      ownedAgents: [
        { agent_id: "ag_owned", display_name: "Owned Agent" },
      ],
      contacts: [
        { contact_agent_id: "hu_contact", alias: "Friend", display_name: "Contact" },
      ],
      rooms: [
        { room_id: "rm_current", name: "Current Room" },
        { room_id: "rm_oc_hidden", name: "Owner Chat" },
        { room_id: "rm_other", name: "Other Room" },
      ],
      roomMembers: [
        { agent_id: "hu_member", display_name: "Human Member" },
      ],
    });

    expect(candidates.map((c) => c.agent_id)).toEqual([
      "ag_owned",
      "hu_contact",
      "hu_member",
      "rm_other",
    ]);
    expect(candidates.find((c) => c.agent_id === "hu_contact")?.display_name).toBe("Friend");
  });
});
