/**
 * Tests for attachment URL normalization in botcord_send.
 * Guards against LLM host hallucination by anchoring hub file URLs to the
 * plugin's configured hubUrl.
 */
import { describe, it, expect } from "vitest";

// Re-implement the private helper here (mirrors plugin/src/tools/messaging.ts).
// Keep this in sync with the source — it intentionally duplicates a tiny
// function so we can unit-test the pure logic without mocking the whole tool.
const FILE_PATH_RE = /^\/hub\/files\/f_[a-zA-Z0-9_-]+$/;

function normalizeAttachmentUrl(url: string, hubUrl: string): string {
  const base = hubUrl.replace(/\/$/, "");
  let path: string;
  try {
    const parsed = new URL(url, base);
    path = parsed.pathname;
    if (!FILE_PATH_RE.test(path)) return url;
  } catch {
    return url;
  }
  return `${base}${path}`;
}

describe("normalizeAttachmentUrl", () => {
  const STABLE = "https://api.botcord.chat";

  it("promotes a relative hub file path to absolute against hubUrl", () => {
    expect(normalizeAttachmentUrl("/hub/files/f_abc", STABLE)).toBe(
      "https://api.botcord.chat/hub/files/f_abc",
    );
  });

  it("is idempotent when host already matches hubUrl", () => {
    expect(
      normalizeAttachmentUrl("https://api.botcord.chat/hub/files/f_abc", STABLE),
    ).toBe("https://api.botcord.chat/hub/files/f_abc");
  });

  it("rewrites a hallucinated wrong-env host back to hubUrl", () => {
    // Original bug: plugin is stable, LLM hallucinated api.test.botcord.chat
    expect(
      normalizeAttachmentUrl(
        "https://api.test.botcord.chat/hub/files/f_af797",
        STABLE,
      ),
    ).toBe("https://api.botcord.chat/hub/files/f_af797");
  });

  it("rewrites an arbitrary external host that carries a hub file path", () => {
    expect(
      normalizeAttachmentUrl("https://evil.com/hub/files/f_abc", STABLE),
    ).toBe("https://api.botcord.chat/hub/files/f_abc");
  });

  it("passes through external URLs whose path is not a hub file path", () => {
    // Non-hub external links stay untouched — agents may legitimately share
    // Google Drive / GitHub / etc. URLs.
    expect(
      normalizeAttachmentUrl(
        "https://drive.google.com/file/d/abc/view",
        STABLE,
      ),
    ).toBe("https://drive.google.com/file/d/abc/view");
  });

  it("passes through invalid URLs without throwing", () => {
    expect(normalizeAttachmentUrl("not a url", STABLE)).toBe("not a url");
  });

  it("tolerates trailing slash in hubUrl", () => {
    expect(
      normalizeAttachmentUrl("/hub/files/f_abc", "https://api.botcord.chat/"),
    ).toBe("https://api.botcord.chat/hub/files/f_abc");
  });
});
