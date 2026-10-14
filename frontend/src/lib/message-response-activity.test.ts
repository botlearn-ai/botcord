import { describe, expect, it } from "vitest";
import { responseState, responseReason, responseAnimation, sortedResponses } from "./message-response-activity";
import type { DashboardMessage, RoomReplyActivity } from "./types";
const a = (id: string, state: NonNullable<RoomReplyActivity["response_state"]>): RoomReplyActivity => ({ agent_id: id, agent_name: id, status: "processing", response_state: state });
describe("response projection consumer", () => {
  it("prefers projected status and preserves ambiguity in older responses", () => {
    expect(responseState(a("a", "ignored"))).toBe("ignored");
    expect(responseState({ agent_id: "a", agent_name: "a", status: "no_reply" })).toBe("unknown");
    expect(responseState({ agent_id: "a", agent_name: "a", status: "completed", basis: "legacy" })).toBe("unknown");
    expect(responseReason("secret token", true)).toBeNull();
  });
  it("prioritizes active and failed agents and animates only the latest active message", () => {
    expect(sortedResponses([a("done", "completed"), a("failed", "failed"), a("think", "processing"), a("reply", "replying")]).map((x) => x.agent_id)).toEqual(["reply", "think", "failed", "done"]);
    const messages = [{ msg_id: "old", reply_activity: [a("a", "replying")] }, { msg_id: "new", reply_activity: [a("b", "processing"), a("c", "replying")] }] as DashboardMessage[];
    expect(responseAnimation(messages)).toBe("new:c");
    messages[1].is_recalled = true;
    expect(responseAnimation(messages)).toBe("old:a");
  });
});
