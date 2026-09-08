import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import WorkspaceModeSwitch from "./WorkspaceModeSwitch";

describe("Workspace mode navigation", () => {
  it("provides a Team entry before joining an organization", () => {
    const html = renderToStaticMarkup(<WorkspaceModeSwitch teamMode={false} personalHref="/chats/messages/room" />);
    expect(html).toMatch(/<a[^>]*href="\/chats\/team"/);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/chats\/messages\/room"/);
  });
  it("marks Team active and preserves the personal conversation destination", () => {
    const html = renderToStaticMarkup(<WorkspaceModeSwitch teamMode personalHref="/chats/messages/room" />);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/chats\/team"/);
    expect(html).toContain('href="/chats/messages/room"');
  });
});
