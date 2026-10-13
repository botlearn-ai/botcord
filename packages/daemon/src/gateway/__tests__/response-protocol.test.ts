import { describe, expect, it } from "vitest";
import { isTeamConversation, parseResponseDecision, responseInputIds } from "../response-protocol.js";
import type { GatewayInboundMessage } from "../types.js";

describe("response protocol", () => {
  it("requires trusted space context on every entry before enabling Team delivery", () => {
    const team = { space_context: { space_id: "sp1" } };
    const message = (raw: unknown) => ({ raw }) as GatewayInboundMessage;
    expect(isTeamConversation(message(team))).toBe(true);
    expect(isTeamConversation(message({ batch: [team, team] }))).toBe(true);
    expect(isTeamConversation(message({ batch: [team, {}] }))).toBe(false);
    expect(isTeamConversation(message({ batch: [] }))).toBe(false);
    expect(isTeamConversation(message(undefined))).toBe(false);
    expect(isTeamConversation(message({ envelope: { payload: team } }))).toBe(false);
  });
  it("keeps every batched message ID and excludes quotes and non-message events", () => {
    const msg = { raw: { batch: [
      { envelope: { type: "message", msg_id: "m1", reply_to: "old" } },
      { envelope: { type: "message", msg_id: "m2" } },
      { envelope: { type: "ack", msg_id: "ack" } },
    ] } } as GatewayInboundMessage;
    expect(responseInputIds(msg)).toEqual(["m1", "m2"]);
  });
  it("validates explicit mixed decisions and does not interpret ordinary prose", () => {
    expect(parseResponseDecision("hello", ["m1"])).toBeNull();
    expect(parseResponseDecision('<botcord-response>{"responds_to":["m1"],"no_reply":["m2"],"text":"done"}</botcord-response>', ["m1", "m2"]))
      .toEqual({ respondsTo: ["m1"], noReply: ["m2"], text: "done" });
    expect(() => parseResponseDecision('<botcord-response>{"responds_to":["foreign"],"text":"done"}</botcord-response>', ["m1"])).toThrow();
    expect(() => parseResponseDecision('<botcord-response>{"responds_to":["m1"],"no_reply":["m1"],"text":"done"}</botcord-response>', ["m1"])).toThrow();
  });
});
