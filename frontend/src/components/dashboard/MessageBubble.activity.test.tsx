// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { DashboardMessage, MessageStatusReaction } from "@/lib/types";
import MessageBubble from "./MessageBubble";
import { TeamMessageFeedbackContext } from "../team/TeamMessageFeedback";
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
    expect(host.querySelector('[data-sender-avatar] img')?.getAttribute("src")).toBe("/profile-me.png");
    await render(["Alice", "Bob", "Carol", "Dave"].map((name) => reaction(name, 10000)));
    expect(host.querySelectorAll('[data-status="replying"]')).toHaveLength(3);
    expect(host.querySelectorAll(".bc-avatar-orbit")).toHaveLength(3);
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

it("puts avatars beside bubbles and only labels other group senders above the bubble", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const message = { hub_msg_id: "m1", msg_id: "m1", sender_id: "hu_peer", sender_name: "Alice", sender_kind: "human", type: "message", text: "Hello", payload: {}, room_id: "rm_group", state: "sent", created_at: new Date().toISOString() } as DashboardMessage;
  try {
    for (const fullWidth of [false, true]) {
      for (const own of [false, true]) {
        await act(() => root.render(<MessageBubble message={{ ...message, is_mine: own }} isOwn={!own} fullWidth={fullWidth} />));
        const bubble = host.querySelector(".liquid-message")!;
        expect(bubble.querySelector("[data-sender-avatar]")).toBeNull();
        expect(host.querySelectorAll("[data-sender-avatar]")).toHaveLength(1);
        expect(host.querySelector("[data-sender-avatar]")?.className).not.toContain("max-md:hidden");
        expect(host.querySelector("[data-sender-name]")?.textContent ?? null).toBe(own ? null : "Alice");
        expect(bubble.querySelector("[data-sender-name]")).toBeNull();
        if (!own) expect(bubble.previousElementSibling?.hasAttribute("data-sender-name")).toBe(true);
      }
    }
    await act(() => root.render(<MessageBubble message={{ ...message, room_id: "rm_dm_hu_me_hu_peer" }} isOwn={false} />));
    expect(host.querySelector("[data-sender-name]")).toBeNull();
    expect(host.querySelectorAll("[data-sender-avatar]")).toHaveLength(1);
  } finally {
    await act(() => root.unmount());
    host.remove();
  }
});

it("uses the durable Team projection instead of a duplicate ephemeral reply indicator", async () => {
  const { TeamMessageFeedbackContext } = await import("@/components/team/TeamMessageFeedback");
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const message = { hub_msg_id: "durable", msg_id: "durable", sender_id: "hu_test", sender_name: "Me", sender_kind: "human", type: "message", text: "Hello", payload: {}, room_id: "rm_group", state: "delivered", created_at: new Date().toISOString(),
    reply_activity: [{ agent_id: "ag_a", agent_name: "A", status: "completed", response_state: "completed" }],
    status_reactions: [{ room_id: "rm_group", msg_id: "durable", actor_id: "ag_a", actor_name: "A", kind: "replying", emoji: "⏳", state: "active" }],
  } as unknown as DashboardMessage;
  try {
    await act(() => root.render(<TeamMessageFeedbackContext.Provider value><MessageBubble message={message} isOwn /></TeamMessageFeedbackContext.Provider>));
    expect(host.querySelector(".replying-avatar")).toBeNull();
    expect(host.querySelector('[data-response-state="completed"]')).not.toBeNull();
  } finally { await act(() => root.unmount()); host.remove(); }
});


it("uses Team response components without leaving a duplicate legacy reply avatar", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const message = { hub_msg_id: "h", msg_id: "m", sender_id: "hu_me", sender_kind: "human", type: "message", text: "Help", payload: {}, room_id: "rm_oc_test", state: "delivered", created_at: new Date().toISOString(), is_mine: true,
    status_reactions: [{ actor_id: "ag_1", actor_name: "A", kind: "replying", state: "active", emoji: "⏳" }],
  } as DashboardMessage;
  try {
    for (const status of ["processing", "completed"] as const) {
      await act(() => root.render(<TeamMessageFeedbackContext.Provider value><MessageBubble isOwn message={{ ...message, reply_activity: [{ agent_id: "ag_1", agent_name: "A", status }] }} /></TeamMessageFeedbackContext.Provider>));
      expect(host.querySelector('[role="status"]')).toBeNull();
      const toolbar = host.querySelector('[role="toolbar"]')!;
      expect(toolbar.querySelectorAll(`[data-response-state="${status}"]`)).toHaveLength(1);
      expect(host.querySelectorAll('[data-status="replying"]')).toHaveLength(0);
      expect(toolbar.querySelectorAll('[data-status="thinking"]')).toHaveLength(status === "processing" ? 1 : 0);
    }
  } finally {
    await act(() => root.unmount());
  }
});

it("opens actions on a stationary touch, cancels scrolling, and mentions an avatar without opening its profile", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const mention = vi.fn();
  window.addEventListener("botcord:composer-mention", mention);
  const pointer = (target: Element, type: string, x = 0, y = 0) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: x, clientY: y });
    target.dispatchEvent(event);
  };
  const message = { hub_msg_id: "m1", msg_id: "m1", sender_id: "hu_peer", sender_name: "Alice", sender_kind: "human", type: "message", text: "Hello", payload: {}, room_id: "rm_group", state: "sent", created_at: new Date().toISOString() } as DashboardMessage;
  try {
    await act(() => root.render(<MessageBubble message={message} isOwn={false} />));
    const bubble = host.querySelector(".liquid-message")!;
    await act(() => { pointer(bubble, "pointerdown"); pointer(bubble, "pointermove", 0, 20); vi.advanceTimersByTime(600); });
    expect(document.querySelector("[data-message-action-item]")).toBeNull();
    await act(() => { pointer(bubble, "pointerdown"); pointer(bubble, "pointercancel"); vi.advanceTimersByTime(600); });
    expect(document.querySelector("[data-message-action-item]")).toBeNull();
    await act(() => { pointer(bubble, "pointerdown"); vi.advanceTimersByTime(500); });
    expect(document.querySelector("[data-message-action-item]")).not.toBeNull();
    await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const avatar = host.querySelector("[data-sender-avatar]")!;
    await act(() => { pointer(avatar, "pointerdown"); vi.advanceTimersByTime(500); pointer(avatar, "pointerup"); });
    expect(mention).toHaveBeenCalledTimes(1);
    expect((mention.mock.calls[0][0] as CustomEvent).detail).toEqual({ roomId: "rm_group", participantId: "hu_peer" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(() => avatar.dispatchEvent(click));
    expect(click.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-message-action-item]")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    window.removeEventListener("botcord:composer-mention", mention);
    await act(() => root.unmount());
    host.remove();
  }
});
