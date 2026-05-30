import { describe, expect, it } from "vitest";

import {
  discoverFeishuChats,
  feishuDiscoveryChatFromEvent,
} from "../gateway/channels/feishu.js";

describe("feishu chat discovery parser", () => {
  it("captures a group chat_id from the registered sender", () => {
    const hit = feishuDiscoveryChatFromEvent(
      {
        sender: { sender_id: { open_id: "ou_alice" } },
        message: {
          message_id: "om_1",
          chat_id: "oc_team",
          chat_type: "group",
          create_time: "1700000000000",
          mentions: [{ id: { open_id: "ou_alice" }, name: "Alice" }],
        },
      },
      "ou_alice",
      () => 1,
    );

    expect(hit).toEqual({
      chatId: "oc_team",
      senderOpenId: "ou_alice",
      kind: "group",
      label: "Alice",
      lastSeenAt: 1700000000000,
    });
  });

  it("marks p2p chat_type as direct", () => {
    const hit = feishuDiscoveryChatFromEvent(
      {
        sender: { sender_id: { open_id: "ou_alice" } },
        message: {
          message_id: "om_2",
          chat_id: "oc_direct",
          chat_type: "p2p",
        },
      },
      "ou_alice",
      () => 1700000000001,
    );

    expect(hit).toMatchObject({
      chatId: "oc_direct",
      senderOpenId: "ou_alice",
      kind: "direct",
      lastSeenAt: 1700000000001,
    });
  });

  it("ignores messages from a different sender", () => {
    const hit = feishuDiscoveryChatFromEvent(
      {
        sender: { sender_id: { open_id: "ou_bob" } },
        message: {
          message_id: "om_3",
          chat_id: "oc_team",
          chat_type: "group",
        },
      },
      "ou_alice",
      () => 1,
    );

    expect(hit).toBeNull();
  });

  it("surfaces temporary discovery websocket start failure", async () => {
    await expect(
      discoverFeishuChats({
        appId: "cli_123",
        appSecret: "secret_123",
        domain: "feishu",
        userOpenId: "ou_alice",
        timeoutSeconds: 0,
        sdkOverride: {
          createDispatcher: () => ({ register: () => {} }),
          createWsClient: () => ({
            start: () => Promise.reject(new Error("ws start failed")),
            close: () => {},
          }),
        },
      }),
    ).rejects.toThrow("ws start failed");
  });
});
