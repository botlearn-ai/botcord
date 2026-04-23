import { describe, expect, it } from "vitest";
import {
  BotCordClient,
  loadStoredCredentials,
  buildHubWebSocketUrl,
} from "@botcord/protocol-core";

describe("@botcord/protocol-core re-exports", () => {
  it("exposes BotCordClient as a class", () => {
    expect(BotCordClient).toBeDefined();
    expect(typeof BotCordClient).toBe("function");
  });

  it("exposes loadStoredCredentials as a function", () => {
    expect(typeof loadStoredCredentials).toBe("function");
  });

  it("buildHubWebSocketUrl converts http → ws + appends /hub/ws", () => {
    expect(typeof buildHubWebSocketUrl).toBe("function");
    const u = buildHubWebSocketUrl("http://localhost:9000");
    expect(u.startsWith("ws://")).toBe(true);
    expect(u).toContain("/hub/ws");
  });
});
