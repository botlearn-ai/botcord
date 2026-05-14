import { describe, expect, it } from "vitest";
import { getShellSkeletonVariantFromPathname } from "./DashboardShellSkeleton";

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
