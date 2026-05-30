import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
import { TopicCard } from "./MessageList";

vi.mock("@/lib/i18n", () => ({
  useLanguage: () => "zh",
}));

vi.mock("./MessageBubble", async () => {
  const React = await import("react");
  return {
    default: ({ message }: { message: DashboardMessage }) => (
      React.createElement("article", { "data-message-bubble": message.msg_id }, message.text)
    ),
  };
});

function message(overrides: Partial<DashboardMessage> = {}): DashboardMessage {
  return {
    hub_msg_id: "hub_1",
    msg_id: "msg_1",
    sender_id: "ag_sender",
    sender_name: "Sender",
    type: "message",
    text: "hello",
    payload: { text: "hello" },
    room_id: "rm_1",
    topic: "Topic",
    topic_id: "topic_1",
    goal: null,
    state: "delivered",
    state_counts: null,
    created_at: "2026-05-29T12:00:00Z",
    source_type: null,
    ...overrides,
  };
}

describe("TopicCard", () => {
  it("renders every topic message through MessageBubble so message actions stay available", () => {
    const html = renderToStaticMarkup(
      React.createElement(TopicCard, {
        group: {
          topicId: "topic_1",
          topicInfo: null,
          topicName: "Topic",
          messages: [
            message({ hub_msg_id: "hub_1", msg_id: "msg_1", text: "first" }),
            message({ hub_msg_id: "hub_2", msg_id: "msg_2", text: "bot reply", sender_id: "ag_owned_bot" }),
            message({ hub_msg_id: "hub_3", msg_id: "msg_3", text: "history" }),
          ],
        },
        currentAgentId: "ag_current",
        onOpen: () => {},
      }),
    );

    expect(html.match(/data-message-bubble=/g)).toHaveLength(3);
    expect(html).toContain("first");
    expect(html).toContain("bot reply");
    expect(html).toContain("history");
  });
});
