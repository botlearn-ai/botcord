import { describe, expect, it } from "vitest";
import {
  hubWake,
  isOwnerTrustedInbound,
  isRestrictedTurn,
  resolveTurnExecution,
  restrictionUnsupported,
  scrubGuestEnv,
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

describe("resolveTurnExecution", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    access_context: {
      grant_id: "g1", space_id: "sp1", role: "collaborator", active: true,
      requester_id: "hu_alice", workspace_path: "~/code/app", allowed_commands: ["npm test"],
      ...over,
    },
  });

  it("runs grantees as collaborator on capable runtimes, restricted elsewhere", () => {
    const cc = resolveTurnExecution(msg({ raw: ctx() }), { runtime: "claude-code" }, botcord);
    expect(cc).toEqual({
      profile: "collaborator",
      grant: {
        grantId: "g1", spaceId: "sp1", role: "collaborator", requesterId: "hu_alice",
        workspacePath: "~/code/app", allowedCommands: ["npm test"],
      },
    });
    expect(resolveTurnExecution(msg({ raw: ctx() }), { runtime: "gemini" }, botcord).profile).toBe("restricted");
    expect(resolveTurnExecution(msg({ raw: ctx({ role: "consultant" }) }), { runtime: "codex" }, botcord).profile)
      .toBe("restricted");
  });

  it("refuses inactive grants and runtimes that cannot enforce them, regardless of route config", () => {
    const inactive = resolveTurnExecution(msg({ raw: ctx({ active: false }) }),
      { runtime: "claude-code", nonOwnerExecution: "full" }, botcord);
    expect(inactive).toMatchObject({ profile: "refused", reason: "grant_inactive" });
    expect(resolveTurnExecution(msg({ raw: ctx() }), { runtime: "openclaw-acp" }, botcord))
      .toMatchObject({ profile: "refused", reason: "runtime_unsupported" });
  });

  it("downgrades mixed batches to read-only and keeps owner turns on default", () => {
    const mixed = msg({ raw: { batch: [ctx(), { source_type: "agent" }] } });
    expect(resolveTurnExecution(mixed, { runtime: "claude-code" }, botcord).profile).toBe("restricted");
    const owner = msg({ conversation: { id: "rm_oc_1", kind: "direct" }, raw: ctx() });
    expect(resolveTurnExecution(owner, { runtime: "claude-code" }, botcord)).toEqual({ profile: "default" });
    expect(resolveTurnExecution(msg(), { runtime: "claude-code" }, botcord)).toEqual({ profile: "default" });
  });
});

describe("scrubGuestEnv", () => {
  it("drops host credentials but keeps runtime auth and ordinary variables", () => {
    const out = scrubGuestEnv({
      PATH: "/usr/bin", HOME: "/home/u", GH_TOKEN: "x", SSH_AUTH_SOCK: "/s", AWS_ACCESS_KEY_ID: "a",
      MY_SERVICE_TOKEN: "t", DB_PASSWORD: "p", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
    });
    expect(out).toEqual({
      PATH: "/usr/bin", HOME: "/home/u", ANTHROPIC_API_KEY: "k", CODEX_HOME: "/c",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
    });
  });
});

describe("team room space_context", () => {
  const team = (restricted: boolean) => ({ source_type: "dashboard_human_room", space_context: { space_id: "sp1", restricted } });

  it("restricts non-owner team-room requests regardless of route config", () => {
    expect(resolveTurnExecution(msg({ raw: team(true) }), { runtime: "claude-code", nonOwnerExecution: "full" }, botcord))
      .toEqual({ profile: "restricted" });
    expect(resolveTurnExecution(msg({ raw: team(true) }), { runtime: "openclaw-acp" }, botcord))
      .toEqual({ profile: "refused", reason: "runtime_unsupported" });
  });

  it("leaves owner requests in team rooms on full permissions", () => {
    expect(resolveTurnExecution(msg({ raw: team(false) }), { runtime: "claude-code" }, botcord))
      .toEqual({ profile: "default" });
  });
});

describe("hub_decision (PR 4)", () => {
  const cc = { runtime: "claude-code" } as const;
  const grant = {
    grant_id: "g1", space_id: "s1", role: "collaborator", active: true,
    requester_id: "hu_a", workspace_path: "/repo", allowed_commands: ["cat"],
  };
  const d = (profile: string, basis = "connection", wake = true) => ({ hub_decision: { wake, wake_reason: "x", profile, basis } });

  it("executes the Hub's profile", () => {
    expect(resolveTurnExecution(msg({ raw: d("full", "owner") }), cc, botcord).profile).toBe("default");
    expect(resolveTurnExecution(msg({ raw: d("full") }), cc, botcord).profile).toBe("default");
    expect(resolveTurnExecution(msg({ raw: d("consult") }), cc, botcord).profile).toBe("restricted");
    expect(resolveTurnExecution(msg({ raw: { ...d("collaborator", "grant"), access_context: grant } }), cc, botcord))
      .toMatchObject({ profile: "collaborator", grant: { grantId: "g1" } });
    // Collaborator without a live grant context drops to read-only.
    expect(resolveTurnExecution(msg({ raw: d("collaborator", "grant") }), cc, botcord).profile).toBe("restricted");
  });

  it("overrides the legacy owner-trust and full-permission defaults", () => {
    // Legacy would trust sender_same_owner; the Hub says consult.
    expect(resolveTurnExecution(msg({ raw: { sender_same_owner: true, ...d("consult") } }), cc, botcord).profile)
      .toBe("restricted");
  });

  it("lets local config tighten but never widen", () => {
    const strict = { runtime: "claude-code", nonOwnerExecution: "restricted" } as const;
    expect(resolveTurnExecution(msg({ raw: d("full", "connection") }), strict, botcord).profile).toBe("restricted");
    expect(resolveTurnExecution(msg({ raw: d("full", "owner_channel") }), strict, botcord).profile).toBe("default");
    const loose = { runtime: "claude-code", nonOwnerExecution: "full" } as const;
    expect(resolveTurnExecution(msg({ raw: d("consult") }), loose, botcord).profile).toBe("restricted");
  });

  it("refuses denied turns and runtimes that cannot enforce restriction", () => {
    expect(resolveTurnExecution(msg({ raw: d("deny", "grant_inactive") }), cc, botcord))
      .toMatchObject({ profile: "refused", reason: "grant_inactive" });
    expect(resolveTurnExecution(msg({ raw: d("deny", "no_path") }), cc, botcord))
      .toMatchObject({ profile: "refused", reason: "hub_denied" });
    expect(resolveTurnExecution(msg({ raw: d("consult") }), { runtime: "kimi" }, botcord))
      .toMatchObject({ profile: "refused", reason: "runtime_unsupported" });
  });

  it("uses the weakest profile in a batch and falls back to legacy when any entry lacks a decision", () => {
    const batch = (...entries: unknown[]) => msg({ raw: { batch: entries } });
    expect(resolveTurnExecution(batch(d("full"), d("consult")), cc, botcord).profile).toBe("restricted");
    expect(resolveTurnExecution(batch(d("consult"), { sender_same_owner: true }), cc, botcord).profile).toBe("default");
  });

  it("wakes when any entry's Hub decision wakes; null without decisions", () => {
    const batch = (...entries: unknown[]) => msg({ raw: { batch: entries } });
    expect(hubWake(batch(d("full", "room", false), d("full", "room", true)))).toBe(true);
    expect(hubWake(batch(d("full", "room", false)))).toBe(false);
    expect(hubWake(msg({ raw: {} }))).toBeNull();
  });

  it("leaves third-party channels to their owner allowlists", () => {
    expect(resolveTurnExecution(msg({ raw: d("deny") }), cc, { botcordChannel: false }).profile).toBe("default");
  });
});

