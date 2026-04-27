import { describe, expect, it } from "vitest";
import {
  ACTIVATE_DEFAULT_NEXT,
  sanitizeNextPath,
} from "@/components/daemon/ActivatePage";

describe("sanitizeNextPath", () => {
  it("returns the default when next is null/undefined/empty", () => {
    expect(sanitizeNextPath(null)).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath(undefined)).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath("")).toBe(ACTIVATE_DEFAULT_NEXT);
  });

  it("accepts same-origin relative paths", () => {
    expect(sanitizeNextPath("/chats/messages")).toBe("/chats/messages");
    expect(sanitizeNextPath("/settings/daemons")).toBe("/settings/daemons");
    expect(sanitizeNextPath("/")).toBe("/");
  });

  it("rejects protocol-relative URLs (open-redirect vector)", () => {
    expect(sanitizeNextPath("//evil.com")).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath("//evil.com/path")).toBe(ACTIVATE_DEFAULT_NEXT);
  });

  it("rejects absolute URLs", () => {
    expect(sanitizeNextPath("http://evil.com")).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath("https://evil.com/x")).toBe(ACTIVATE_DEFAULT_NEXT);
  });

  it("rejects pseudo-URL schemes", () => {
    expect(sanitizeNextPath("javascript:alert(1)")).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath("data:text/html,foo")).toBe(ACTIVATE_DEFAULT_NEXT);
  });

  it("rejects relative paths without a leading slash", () => {
    expect(sanitizeNextPath("settings/daemons")).toBe(ACTIVATE_DEFAULT_NEXT);
    expect(sanitizeNextPath("../etc/passwd")).toBe(ACTIVATE_DEFAULT_NEXT);
  });
});
