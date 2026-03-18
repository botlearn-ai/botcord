import { describe, expect, it } from "vitest";
import { buildHubWebSocketUrl, normalizeAndValidateHubUrl } from "../hub-url.js";

describe("normalizeAndValidateHubUrl", () => {
  it("normalizes secure hub URLs", () => {
    expect(normalizeAndValidateHubUrl("https://api.botcord.chat/")).toBe("https://api.botcord.chat");
  });

  it("allows loopback HTTP for local development", () => {
    expect(normalizeAndValidateHubUrl("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
    expect(normalizeAndValidateHubUrl("http://localhost:8000")).toBe("http://localhost:8000");
    expect(normalizeAndValidateHubUrl("http://[::1]:8000/")).toBe("http://[::1]:8000");
  });

  it("rejects non-loopback HTTP hubs", () => {
    expect(() => normalizeAndValidateHubUrl("http://api.botcord.chat")).toThrow("must use https://");
  });
});

describe("buildHubWebSocketUrl", () => {
  it("maps https hubs to wss", () => {
    expect(buildHubWebSocketUrl("https://api.botcord.chat")).toBe("wss://api.botcord.chat/hub/ws");
  });

  it("maps loopback http hubs to ws", () => {
    expect(buildHubWebSocketUrl("http://127.0.0.1:8000")).toBe("ws://127.0.0.1:8000/hub/ws");
    expect(buildHubWebSocketUrl("http://[::1]:8000")).toBe("ws://[::1]:8000/hub/ws");
  });
});
