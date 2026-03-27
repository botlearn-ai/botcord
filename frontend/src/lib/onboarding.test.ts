/**
 * [INPUT]: 依赖 onboarding Prompt 构造函数输出给外部代理的邀请执行说明
 * [OUTPUT]: 对外提供邀请 Prompt 关键契约测试，锁定请求头与请求体提示
 * [POS]: frontend/lib 的模板回归护栏，防止邀请文案再次丢失最小请求参数
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { describe, expect, it } from "vitest";

import { buildFriendInvitePrompt, buildSelfJoinPrompt, buildSharePrompt } from "./onboarding";

describe("invite onboarding prompts", () => {
  it("includes redeem request headers for friend invites in zh", () => {
    const prompt = buildFriendInvitePrompt({
      inviteCode: "iv_demo",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "zh",
    });

    expect(prompt).toContain("接受邀请：POST https://api.botcord.chat/api/invites/iv_demo/redeem");
    expect(prompt).toContain("查看邀请详情：GET https://api.botcord.chat/api/invites/iv_demo");
    expect(prompt).toContain("请求头参数：无");
    expect(prompt).toContain("请求头参数：Authorization: Bearer <BotCord access token>, X-Active-Agent: <当前 Bot 的 agent_id>");
    expect(prompt).toContain("JSON 参数：无");
  });

  it("includes redeem request headers for invite-code room shares in en", () => {
    const prompt = buildSharePrompt({
      inviteCode: "iv_room",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "en",
    });

    expect(prompt).toContain("Accept the invite: POST https://api.botcord.chat/api/invites/iv_room/redeem");
    expect(prompt).toContain("Preview invite details: GET https://api.botcord.chat/api/invites/iv_room");
    expect(prompt).toContain("Required headers: none");
    expect(prompt).toContain("Required headers: Authorization: Bearer <BotCord access token>, X-Active-Agent: <current_bot_agent_id>");
    expect(prompt).toContain("JSON params: none");
  });

  it("includes request params for share lookup prompts in zh", () => {
    const prompt = buildSharePrompt({
      shareId: "sh_demo",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "zh",
    });

    expect(prompt).toContain("查看分享详情并获取 room_id：GET https://api.botcord.chat/api/share/sh_demo");
    expect(prompt).toContain("请求头参数：无");
    expect(prompt).toContain("JSON 参数：无");
  });

  it("includes request params for self join prompts in en", () => {
    const prompt = buildSelfJoinPrompt({
      roomId: "rm_demo",
      roomName: "Room",
      hubApiBaseUrl: "https://api.botcord.chat",
      installGuideUrl: "https://www.botcord.chat/openclaw-setup-instruction-script.md",
      locale: "en",
    });

    expect(prompt).toContain("Join the group: POST https://api.botcord.chat/hub/rooms/rm_demo/members");
    expect(prompt).toContain("Required headers: Authorization: Bearer <current_bot_agent_token>");
    expect(prompt).toContain("JSON params: {\"agent_id\":\"<current_bot_agent_id>\"}");
  });
});
