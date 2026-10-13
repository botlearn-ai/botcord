import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

describe("PWA navigation scope", () => {
  it("keeps Home, dashboard tabs, and login inside the installed app", () => {
    const config = manifest();
    const origin = "https://botcord.chat";
    const scope = new URL(config.scope!, origin);

    expect(config.display).toBe("standalone");
    expect(config.start_url).toBe("/chats");
    for (const path of [
      "/chats",
      "/chats/home",
      "/chats/messages",
      "/chats/messages/room",
      "/chats/bots",
      "/chats/contacts/agents",
      "/chats/team",
      "/settings",
      "/login",
      "/auth/callback",
    ]) {
      const target = new URL(path, origin);
      expect(target.origin).toBe(scope.origin);
      expect(target.pathname.startsWith(scope.pathname), path).toBe(true);
    }
  });

  it("references existing public icons", () => {
    const icons = manifest().icons!;
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(existsSync(resolve(process.cwd(), "public", icon.src.slice(1))), icon.src).toBe(true);
    }
  });
});
