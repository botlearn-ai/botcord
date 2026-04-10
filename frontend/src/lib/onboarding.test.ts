/**
 * [INPUT]: 依赖 onboarding Prompt 构造函数输出给外部代理的邀请执行说明
 * [OUTPUT]: 对外提供邀请 Prompt 关键契约测试，锁定请求头与请求体提示
 * [POS]: frontend/lib 的模板回归护栏，防止邀请文案再次丢失最小请求参数
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { describe, expect, it } from "vitest";

import { buildFriendInvitePrompt, buildSelfJoinPrompt, buildSharePrompt } from "./onboarding";

describe("invite onboarding prompts", () => {
  it("includes redeem instructions for friend invites in zh", () => {
    const prompt = buildFriendInvitePrompt({
      inviteCode: "iv_demo",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "zh",
    });

    expect(prompt).toContain("接受邀请：POST https://api.botcord.chat/hub/invites/iv_demo/redeem");
    expect(prompt).toContain("查看邀请详情：GET https://api.botcord.chat/hub/invites/iv_demo");
    expect(prompt).toContain("Authorization: Bearer <agent_jwt_token>");
  });

  it("includes redeem instructions for invite-code room shares in en", () => {
    const prompt = buildSharePrompt({
      inviteCode: "iv_room",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "en",
    });

    expect(prompt).toContain("Accept the invite: POST https://api.botcord.chat/hub/invites/iv_room/redeem");
    expect(prompt).toContain("Preview invite details: GET https://api.botcord.chat/hub/invites/iv_room");
    expect(prompt).toContain("Authorization: Bearer <agent_jwt_token>");
  });

  it("includes share lookup URL for share prompts in zh", () => {
    const prompt = buildSharePrompt({
      shareId: "sh_demo",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "zh",
    });

    expect(prompt).toContain("查看分享详情并获取 room_id：GET https://api.botcord.chat/api/share/sh_demo");
  });

  it("includes join instructions for self join prompts in en", () => {
    const prompt = buildSelfJoinPrompt({
      roomId: "rm_demo",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "en",
    });

    expect(prompt).toContain("Join the group: POST https://api.botcord.chat/hub/rooms/rm_demo/members");
    expect(prompt).toContain("Authorization: Bearer <agent_jwt_token>");
    expect(prompt).toContain('JSON body: {"agent_id":"<your_agent_id>"}');
  });

  it("generates subscription step instructions for paid room with productId in zh", () => {
    const prompt = buildSharePrompt({
      roomId: "rm_paid",
      roomName: "Premium Room",
      requiresPayment: true,
      productId: "sp_abc123",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "zh",
    });

    expect(prompt).toContain("步骤一");
    expect(prompt).toContain("sp_abc123");
    expect(prompt).toContain("botcord_subscription");
    expect(prompt).toContain('"subscribe"');
    expect(prompt).toContain("步骤二");
    expect(prompt).toContain("botcord_rooms");
    expect(prompt).toContain("rm_paid");
  });

  it("generates subscription step instructions for paid room with productId in en", () => {
    const prompt = buildSharePrompt({
      inviteCode: "iv_paid",
      roomName: "Premium Room",
      requiresPayment: true,
      productId: "sp_xyz789",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "en",
    });

    expect(prompt).toContain("Step 1");
    expect(prompt).toContain("sp_xyz789");
    expect(prompt).toContain("botcord_subscription");
    expect(prompt).toContain('action "subscribe"');
    expect(prompt).toContain("Step 2");
    expect(prompt).toContain("botcord_contacts");
    expect(prompt).toContain("redeem_invite");
  });

  it("falls back to generic note when requiresPayment but no productId", () => {
    const prompt = buildSharePrompt({
      roomId: "rm_paid",
      roomName: "Premium Room",
      requiresPayment: true,
      hubApiBaseUrl: "https://api.botcord.chat",
      locale: "zh",
    });

    expect(prompt).not.toContain("步骤一");
    expect(prompt).toContain("注意：该群需要付费订阅，请先完成订阅再加入。");
  });
});
