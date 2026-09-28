import { describe, expect, it } from "vitest";
import {
  isOwnerTrustedInbound,
  isRestrictedTurn,
  restrictionUnsupported,
} from "../execution-policy.js";
import type { GatewayInboundMessage } from "../types.js";

function msg(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: "hub_1",
    channel: "botcord",
    accountId: "ag_me",
    conversation: { id: "rm_group", kind: "group" },
    sender: { id: "ag_other", kind: "agent" },
    text: "hi",
    raw: {},
    receivedAt: 0,
    ...partial,
  };
}

const botcord = { botcordChannel: true };

describe("isOwnerTrustedInbound", () => {
  it("trusts owner-chat rooms and owner-issued source types", () => {
    expect(isOwnerTrustedInbound(msg({ conversation: { id: "rm_oc_1", kind: "direct" } }), botcord)).toBe(true);
    for (const source_type of ["dashboard_user_chat", "cloud_agent_run", "botcord_schedule", "cloud_gateway_ingress"]) {
      expect(isOwnerTrustedInbound(msg({ raw: { source_type } }), botcord)).toBe(true);
    }
  });

  it("does not trust other humans, agents or unknown sources", () => {
    expect(isOwnerTrustedInbound(msg(), botcord)).toBe(false);
    expect(isOwnerTrustedInbound(msg({ raw: { source_type: "dashboard_human_room" } }), botcord)).toBe(false);
    expect(isOwnerTrustedInbound(msg({ raw: { source_type: "agent" } }), botcord)).toBe(false);
  });

  it("trusts senders the Hub marks as owned by the same owner", () => {
    expect(isOwnerTrustedInbound(msg({ raw: { source_type: "agent", sender_same_owner: true } }), botcord)).toBe(true);
    expect(isOwnerTrustedInbound(msg({ raw: { source_type: "agent", sender_same_owner: false } }), botcord)).toBe(false);
  });

  it("requires every batched entry to be owner-issued", () => {
    const owner = { source_type: "dashboard_user_chat" };
    expect(isOwnerTrustedInbound(msg({ raw: { batch: [owner, owner] } }), botcord)).toBe(true);
    expect(isOwnerTrustedInbound(msg({ raw: { batch: [owner, { sender_same_owner: true }] } }), botcord)).toBe(true);
    expect(isOwnerTrustedInbound(msg({ raw: { batch: [owner, { source_type: "agent" }] } }), botcord)).toBe(false);
  });

  it("treats third-party channels as owner-trusted (owner allowlists gate them)", () => {
    expect(isOwnerTrustedInbound(msg({ conversation: { id: "telegram:1", kind: "direct" } }), { botcordChannel: false })).toBe(true);
  });
});

describe("isRestrictedTurn", () => {
  it("restricts non-owner turns only on routes that opt in", () => {
    expect(isRestrictedTurn(msg(), { runtime: "claude-code", nonOwnerExecution: "restricted" }, botcord)).toBe(true);
    expect(isRestrictedTurn(msg(), { runtime: "claude-code" }, botcord)).toBe(false);
    expect(isRestrictedTurn(msg(), { runtime: "codex", nonOwnerExecution: "full" }, botcord)).toBe(false);
  });

  it("reports runtimes that cannot enforce restriction instead of restricting them", () => {
    const restricted = { nonOwnerExecution: "restricted" as const };
    expect(isRestrictedTurn(msg(), { runtime: "openclaw-acp", ...restricted }, botcord)).toBe(false);
    expect(restrictionUnsupported(msg(), { runtime: "openclaw-acp", ...restricted }, botcord)).toBe(true);
    expect(restrictionUnsupported(msg(), { runtime: "kimi-cli" }, botcord)).toBe(false);
  });
});
