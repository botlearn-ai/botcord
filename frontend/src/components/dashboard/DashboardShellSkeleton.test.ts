import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DashboardShellSkeleton, { getShellSkeletonVariantFromPathname, shellSkeletonHasOpenConversation } from "./DashboardShellSkeleton";

describe("getShellSkeletonVariantFromPathname", () => {
  it("treats /chats root and home routes as home", () => {
    expect(getShellSkeletonVariantFromPathname("/chats")).toBe("home");
    expect(getShellSkeletonVariantFromPathname("/chats/home")).toBe("home");
    expect(getShellSkeletonVariantFromPathname(null)).toBe("home");
  });

  it("maps message aliases to the messages skeleton", () => {
    expect(getShellSkeletonVariantFromPathname("/chats/messages")).toBe("messages");
    expect(getShellSkeletonVariantFromPathname("/chats/messages/rm_123")).toBe("messages");
    expect(getShellSkeletonVariantFromPathname("/chats/dm")).toBe("messages");
    expect(getShellSkeletonVariantFromPathname("/chats/rooms")).toBe("messages");
    expect(getShellSkeletonVariantFromPathname("/chats/user-chat")).toBe("messages");
  });

  it("keeps other supported tabs distinct", () => {
    expect(getShellSkeletonVariantFromPathname("/chats/contacts")).toBe("contacts");
    expect(getShellSkeletonVariantFromPathname("/chats/explore")).toBe("explore");
    expect(getShellSkeletonVariantFromPathname("/chats/wallet")).toBe("wallet");
    expect(getShellSkeletonVariantFromPathname("/chats/activity")).toBe("activity");
    expect(getShellSkeletonVariantFromPathname("/chats/bots")).toBe("bots");
  });
});

describe("shellSkeletonHasOpenConversation", () => {
  it("treats room-less message routes as the empty state", () => {
    expect(shellSkeletonHasOpenConversation("/chats/messages")).toBe(false);
    expect(shellSkeletonHasOpenConversation("/chats/dm")).toBe(false);
    expect(shellSkeletonHasOpenConversation("/chats/rooms")).toBe(false);
    expect(shellSkeletonHasOpenConversation("/chats/contacts")).toBe(false);
    expect(shellSkeletonHasOpenConversation(null)).toBe(false);
  });

  it("detects routes that resolve to an open conversation", () => {
    expect(shellSkeletonHasOpenConversation("/chats/messages/rm_123")).toBe(true);
    expect(shellSkeletonHasOpenConversation("/chats/dm/rm_dm_123")).toBe(true);
    expect(shellSkeletonHasOpenConversation("/chats/rooms/rm_123")).toBe(true);
    expect(shellSkeletonHasOpenConversation("/chats/user-chat")).toBe(true);
  });
});

const route = vi.hoisted(() => ({ pathname: "/chats/team" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));

describe("refresh shell mode layout", () => {
  it("recognizes Team routes instead of falling back to Home", () => {
    expect(getShellSkeletonVariantFromPathname("/chats/team")).toBe("team");
    expect(shellSkeletonHasOpenConversation("/chats/team")).toBe(false);
  });

  it("keeps Team selected during bootstrap and hides personal navigation", () => {
    route.pathname = "/chats/team";
    const html = renderToStaticMarkup(React.createElement(DashboardShellSkeleton));
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/chats\/team"/);
    expect(html).toContain("正在加载团队空间");
    expect(html).not.toContain("My Bots");
    expect(html).not.toContain("Messages");
    expect(html).toContain("h-14 shrink-0");
  });

  it("reserves the same mode header above the personal message skeleton", () => {
    route.pathname = "/chats/messages/rm_123";
    const html = renderToStaticMarkup(React.createElement(DashboardShellSkeleton));
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*href="\/chats\/messages\/rm_123"/);
    expect(html).toContain('href="/chats/team"');
    expect(html).toContain("Messages");
    expect(html).not.toContain("正在加载团队空间");
  });
});
