import { describe, expect, it } from "vitest";
import { parseResponseDecision, responseInputIds } from "../response-protocol.js";
import type { GatewayInboundMessage } from "../types.js";

describe("response protocol", () => {
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
