import { describe, expect, it } from "vitest";
import type { DashboardMessage, DashboardRoom } from "@/lib/types";
import { canRecallDashboardMessage } from "@/lib/message-recall";

function message(overrides: Partial<DashboardMessage> = {}): DashboardMessage {
  return {
    hub_msg_id: "h_1",
    msg_id: "msg_1",
    sender_id: "hu_1",
    sender_name: "Alice",
    type: "message",
    text: "hello",
    payload: { text: "hello" },
    room_id: "rm_1",
    topic: null,
    topic_id: null,
    goal: null,
    state: "queued",
    state_counts: null,
    created_at: "2026-05-29T08:00:00.000Z",
    source_type: "dashboard_human_room",
    source_user_id: "user_1",
    is_mine: true,
    ...overrides,
  };
}

function room(overrides: Partial<DashboardRoom> = {}): DashboardRoom {
  return {
    room_id: "rm_1",
    name: "Room",
    description: "",
    owner_id: "ag_owner",
    owner_type: "agent",
    visibility: "private",
    member_count: 2,
    my_role: "member",
    rule: null,
    has_unread: false,
    last_message_preview: null,
    last_message_at: null,
    last_sender_name: null,
    ...overrides,
  };
}

describe("canRecallDashboardMessage", () => {
  it("allows a freshly persisted own message even when is_mine is missing", () => {
    expect(canRecallDashboardMessage({
      message: message({ is_mine: undefined }),
      room: room(),
      isOwn: false,
      ownedAgentIds: [],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(true);
  });

  it("allows fresh own error messages to be recalled", () => {
    expect(canRecallDashboardMessage({
      message: message({
        type: "error",
        payload: { error: { code: "agent_error", message: "failed" } },
        text: "failed",
      }),
      room: room(),
      isOwn: true,
      ownedAgentIds: [],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(true);
  });

  it("does not allow non-error receipt messages to be recalled", () => {
    for (const type of ["ack", "result"]) {
      expect(canRecallDashboardMessage({
        message: message({ type }),
        room: room(),
        isOwn: true,
        ownedAgentIds: [],
        humanId: "hu_1",
        userId: "user_1",
        nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
      })).toBe(false);
    }
  });

  it("does not expose recall on temporary optimistic ids", () => {
    expect(canRecallDashboardMessage({
      message: message({ hub_msg_id: "tmp_1", msg_id: "tmp_1" }),
      room: room(),
      isOwn: true,
      ownedAgentIds: [],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(false);
  });

  it("does not expose recall while only the hub id has been persisted", () => {
    expect(canRecallDashboardMessage({
      message: message({ hub_msg_id: "h_real", msg_id: "tmp_1" }),
      room: room(),
      isOwn: true,
      ownedAgentIds: [],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(false);
  });

  it("allows the owner of the room owner bot to recall any room message", () => {
    expect(canRecallDashboardMessage({
      message: message({
        sender_id: "ag_other",
        source_user_id: null,
        created_at: "2026-05-29T07:00:00.000Z",
      }),
      room: room({ owner_id: "ag_owner", owner_type: "agent", my_role: "member" }),
      isOwn: false,
      ownedAgentIds: ["ag_owner"],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(true);
  });

  it("allows the human owner to recall their own bot's fresh room message", () => {
    expect(canRecallDashboardMessage({
      message: message({
        sender_id: "ag_owned",
        source_user_id: null,
        created_at: "2026-05-29T08:00:00.000Z",
      }),
      room: room({ owner_id: "ag_other", owner_type: "agent", my_role: "member" }),
      isOwn: false,
      ownedAgentIds: ["ag_owned"],
      humanId: "hu_1",
      userId: "user_1",
      nowMs: Date.parse("2026-05-29T08:01:00.000Z"),
    })).toBe(true);
  });
});
