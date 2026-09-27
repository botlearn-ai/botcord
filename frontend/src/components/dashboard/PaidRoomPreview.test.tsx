import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { PublicRoomMessagePreview } from "@/lib/types";

const fixture = vi.hoisted(() => ({
  messages: null as PublicRoomMessagePreview[] | null,
  loading: true,
  error: null as unknown,
  load: vi.fn(),
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "en" }));
vi.mock("./SubscriptionBadge", () => ({ default: () => <button>Subscribe</button> }));
vi.mock("./paid-room-preview-cache", async () => {
  const { createStore } = await import("zustand/vanilla");
  return { getPaidRoomPreviewStore: (roomId: string) => createStore(() => roomId === "room" ? fixture : { ...fixture, messages: null, loading: true, error: null }) };
});
import PaidRoomPreview from "./PaidRoomPreview";
const render = (roomId = "room") => renderToStaticMarkup(
  <PaidRoomPreview roomId={roomId} productId="product" isGuest={false} loginHref="/login" />
);
beforeEach(() => {
  fixture.messages = null;
  fixture.loading = true;
  fixture.error = null;
});
it("renders cold-loading feedback on the first paint instead of an empty preview", () => {
  const html = render();
  expect(html).toContain("Loading previews...");
  expect(html).not.toContain("No preview messages yet");
});
it("keeps cached summaries and the subscription action visible during revalidation", () => {
  fixture.loading = false;
  fixture.messages = [{ hub_msg_id: "message", sender_id: "sender", sender_name: "Sender", preview: "Public summary", created_at: null }];
  const html = render();
  expect(html).toContain("Public summary");
  expect(html).toContain("Subscribe");
  expect(html).not.toContain("Loading previews...");
});
it("shows a cached empty result without restarting the loading placeholder", () => {
  fixture.loading = false;
  fixture.messages = [];
  const html = render();
  expect(html).toContain("No preview messages yet");
  expect(html).not.toContain("Loading previews...");
});
it("offers explicit retry after a preview request fails", () => {
  fixture.loading = false;
  fixture.error = new Error("denied");
  const html = render();
  expect(html).toContain('role="alert"');
  expect(html).toContain("Unable to load previews");
  expect(html).toContain("Retry");
  expect(html).not.toContain("No preview messages yet");
});

it("renders another room without exposing the previous room's preview", () => {
  fixture.loading = false;
  fixture.messages = [{ hub_msg_id: "message", sender_id: "sender", sender_name: "Sender", preview: "Previous room summary", created_at: null }];
  expect(render()).toContain("Previous room summary");
  const html = render("other");
  expect(html).not.toContain("Previous room summary");
  expect(html).toContain("Loading previews...");
});

it("keeps fresh summaries visible with retry feedback on a network refresh failure", () => {
  fixture.loading = false;
  fixture.messages = [{ hub_msg_id: "message", sender_id: "sender", sender_name: "Sender", preview: "Public summary", created_at: null }];
  fixture.error = new Error("offline");
  const html = render();
  expect(html).toContain("Public summary");
  expect(html).toContain("Unable to refresh previews.");
  expect(html).toContain("Retry");
});
