// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DashboardMessage, MessageStatusReaction } from "@/lib/types";
import MessageBubble from "./MessageBubble";
vi.mock("@/lib/anime", () => ({ animateIfMotion: () => null, cleanupAnime: () => {}, animeStagger: () => 0 }));
vi.mock("@/lib/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "zh" }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.useRealTimers());

it("shows real agent activity independently of receipts and removes each actor on expiry or clear", async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const reaction = (actor: string, ms: number): MessageStatusReaction => ({ room_id: "rm_test", msg_id: "msg_test", actor_id: `ag_${actor}`, actor_name: actor, kind: "replying", emoji: "⏳", state: "active", expires_at: new Date(now + ms).toISOString() });
  const message = { hub_msg_id: "msg_test", msg_id: "msg_test", sender_id: "hu_test", sender_name: "Me", sender_avatar_url: "/profile-me.png", sender_kind: "human", type: "message", text: "请帮忙看看", payload: { text: "请帮忙看看" }, room_id: "rm_test", state: "delivered", created_at: new Date(now).toISOString() } as DashboardMessage;
  const render = (reactions: MessageStatusReaction[]) => act(() => root.render(<MessageBubble message={{ ...message, status_reactions: reactions }} isOwn />));
  try {
    await render([]);
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('.md\\:hidden img')?.getAttribute("src")).toBe("/profile-me.png");
    await render(["Alice", "Bob", "Carol", "Dave"].map((name) => reaction(name, 10000)));
    expect(host.querySelectorAll(".replying-avatar")).toHaveLength(3);
    expect(host.querySelector('[role="status"]')?.textContent).toContain("+1");
    const reactions = [reaction("Alice", 1000), reaction("Bob", 2000)];
    await render(reactions);
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Alice、Bob 正在回复");
    await act(() => vi.advanceTimersByTime(1100));
    expect(host.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Bob 正在回复");
    await act(() => vi.advanceTimersByTime(1100));
    expect(host.querySelector('[role="status"]')).toBeNull();
    await render([{ ...reaction("Alice", 10000), state: "cleared" }]);
    expect(host.querySelector('[role="status"]')).toBeNull();
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});
